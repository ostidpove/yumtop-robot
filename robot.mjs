// =====================================================================
// YumTop — robot serveur (roule tout seul sur GitHub toutes les 10 minutes)
//  0. (sur demande) Précharge une province entière, ex. PRELOAD=QC
//  1. Charge les restos Foursquare des nouvelles régions demandées par l'app
//     (Supabase réveille le robot dès qu'une nouvelle région est demandée)
//  2. Rafraîchit chaque région une fois par mois (nouveaux restos, restos fermés)
//  3. Analyse les nouvelles photos (floue ? sombre ?)
//  4. Envoie par courriel les suggestions de langue
// Les clés viennent des « secrets » GitHub : elles ne sont jamais écrites ici ni affichées.
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { DuckDBInstance } from '@duckdb/node-api';
import sharp from 'sharp';

const TILE = 0.5;                 // taille d'une région (degrés)
const MAX_TILES_PER_RUN = 25;     // nouvelles régions par passage (préchargement : sans limite)
const MAX_REFRESH_PER_RUN = 3;    // régions rafraîchies par passage
const REFRESH_DAYS = 30;
const MAX_PHOTOS_PER_RUN = 60;
export const DARK_BELOW = 45;     // luminosité moyenne (0-255) sous laquelle la photo est « sombre »
export const BLURRY_BELOW = 60;   // netteté sous laquelle la photo est « floue »

const env = (k, required = true) => {
  const v = (process.env[k] ?? '').trim();
  if (!v && required) throw new Error(`Secret manquant : ${k}`);
  return v;
};
const hide = (msg) => {
  let s = String(msg?.message ?? msg);
  for (const k of ['FSQ_TOKEN', 'SUPABASE_SERVICE_KEY', 'RESEND_API_KEY']) { const v = process.env[k]; if (v) s = s.replaceAll(v, '[secret]'); }
  return s.slice(0, 500);
};

// ---------- Analyse d'une photo : luminosité moyenne + netteté (variance du laplacien) ----------
export async function analyzePhoto(buffer) {
  const { data, info } = await sharp(buffer).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const px = (x, y) => data[(y * w + x) * ch];
  let sum = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sum += px(x, y);
  const brightness = sum / (w * h);
  let n = 0, m = 0, m2 = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const l = 4 * px(x, y) - px(x - 1, y) - px(x + 1, y) - px(x, y - 1) - px(x, y + 1);
    n++; const d = l - m; m += d / n; m2 += d * (l - m);
  }
  const sharpness = n > 1 ? m2 / (n - 1) : 0;
  return { brightness, sharpness, ok: brightness >= DARK_BELOW && sharpness >= BLURRY_BELOW };
}

async function main() {
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();

  // Régions restées bloquées en « loading » (passage interrompu) : on les remet en attente
  await db.from('regions').update({ status: 'pending' }).eq('status', 'loading').lt('requested_at', new Date(Date.now() - 3600e3).toISOString());

  let con = null;
  const duck = async () => {
    if (con) return con;
    const instance = await DuckDBInstance.create(':memory:');
    con = await instance.connect();
    await con.run('INSTALL httpfs; LOAD httpfs; INSTALL iceberg; LOAD iceberg;');
    await con.run(`CREATE SECRET iceberg_secret (TYPE ICEBERG, TOKEN '${env('FSQ_TOKEN').replace(/'/g, "''")}');`);
    await con.run(`ATTACH 'places' AS places (TYPE iceberg, SECRET iceberg_secret, ENDPOINT 'https://catalog.h3-hub.foursquare.com/iceberg');`);
    return con;
  };

  // ---------- 0 : préchargement d'une province (lancé à la main) ----------
  const preload = env('PRELOAD', false).toUpperCase();
  if (preload) {
    if (!/^[A-Z]{2}$/.test(preload)) throw new Error('PRELOAD doit être un code de 2 lettres, ex. QC');
    // Dans Foursquare, la province est parfois écrite autrement (Québec, Quebec…)
    const names = preload === 'QC' ? `'QC','QUEBEC','QUÉBEC','QUÉBÉC','QUÉBEC (PROVINCE)'` : `'${preload}'`;
    const r = await (await duck()).runAndReadAll(`
      SELECT DISTINCT floor(latitude * 2) / 2 AS tile_lat, floor(longitude * 2) / 2 AS tile_lon
      FROM places.datasets.places_os
      WHERE country = 'CA' AND upper(trim(region)) IN (${names})
        AND date_closed IS NULL AND name IS NOT NULL
        AND array_to_string(fsq_category_labels, ' | ') ILIKE '%Dining and Drinking%'`);
    const t = r.getRowObjectsJson().map((x) => ({ tile_lat: Number(x.tile_lat), tile_lon: Number(x.tile_lon), status: 'pending' }));
    const { error } = await db.from('regions').upsert(t, { onConflict: 'tile_lat,tile_lon', ignoreDuplicates: true });
    if (error) throw error;
    console.log(`Préchargement ${preload} : ${t.length} régions à charger`);
  }

  // ---------- 1 et 2 : régions à charger ----------
  const { data: fresh, error: e1 } = await db.from('regions').select('tile_lat, tile_lon, attempts')
    .or('status.eq.pending,and(status.eq.error,attempts.lt.3)').order('requested_at').limit(preload ? 2000 : MAX_TILES_PER_RUN);
  if (e1) throw e1;
  const { data: old, error: e2 } = await db.from('regions').select('tile_lat, tile_lon, attempts')
    .eq('status', 'ready').lt('loaded_at', new Date(Date.now() - REFRESH_DAYS * 86400e3).toISOString()).order('loaded_at').limit(MAX_REFRESH_PER_RUN);
  if (e2) throw e2;
  const tiles = [...(fresh ?? []), ...(old ?? [])];

  if (tiles.length) {
    await duck();
    let done = 0, total = 0;
    for (const t of tiles) {
      const lat0 = Number(t.tile_lat), lon0 = Number(t.tile_lon);
      const key = { tile_lat: t.tile_lat, tile_lon: t.tile_lon };
      const started = new Date().toISOString();
      await db.from('regions').update({ status: 'loading', attempts: (t.attempts ?? 0) + 1 }).match(key);
      try {
        const reader = await con.runAndReadAll(`
          SELECT fsq_place_id, name, address, locality, region, country, latitude, longitude,
                 array_to_string(fsq_category_labels, ' | ') AS categories
          FROM places.datasets.places_os
          WHERE latitude >= ${lat0} AND latitude < ${lat0 + TILE}
            AND longitude >= ${lon0} AND longitude < ${lon0 + TILE}
            AND date_closed IS NULL AND name IS NOT NULL
            AND array_to_string(fsq_category_labels, ' | ') ILIKE '%Dining and Drinking%'`);
        const rows = reader.getRowObjectsJson().map((r) => ({ ...r, latitude: Number(r.latitude), longitude: Number(r.longitude), loaded_at: started }));
        for (let i = 0; i < rows.length; i += 1000) {
          const { error } = await db.from('fsq_places').upsert(rows.slice(i, i + 1000), { onConflict: 'fsq_place_id' });
          if (error) throw error;
        }
        // Restos disparus ou fermés depuis le dernier chargement
        const { error: eDel } = await db.from('fsq_places').delete()
          .gte('latitude', lat0).lt('latitude', lat0 + TILE).gte('longitude', lon0).lt('longitude', lon0 + TILE)
          .or(`loaded_at.is.null,loaded_at.lt."${started}"`);
        if (eDel) throw eDel;
        await db.from('regions').update({ status: 'ready', loaded_at: started, place_count: rows.length, error: null }).match(key);
        done++; total += rows.length;
        console.log(`Région ${lat0}, ${lon0} : ${rows.length} restos  (${done}/${tiles.length}, total ${total})`);
      } catch (err) {
        await db.from('regions').update({ status: 'error', error: hide(err) }).match(key);
        console.log(`Région ${lat0}, ${lon0} : ERREUR ${hide(err)}`);
      }
    }
  }

  // ---------- 3 : nouvelles photos ----------
  const { data: photos, error: e3 } = await db.from('reviews').select('id, photo_path').is('photo_checked_at', null).order('created_at').limit(MAX_PHOTOS_PER_RUN);
  if (e3) throw e3;
  for (const p of photos ?? []) {
    let patch = { photo_checked_at: nowIso };
    try {
      const { data: blob, error } = await db.storage.from('photos').download(p.photo_path);
      if (error) throw error;
      const a = await analyzePhoto(Buffer.from(await blob.arrayBuffer()));
      patch = { ...patch, photo_brightness: a.brightness, photo_sharpness: a.sharpness, photo_ok: a.ok };
    } catch (err) {
      console.log(`Photo ${p.id} : analyse impossible (${hide(err)})`);   // laissée « inconnue », donc acceptée
    }
    await db.from('reviews').update(patch).eq('id', p.id);
  }
  if (photos?.length) console.log(`${photos.length} photo(s) analysée(s)`);

  // ---------- 4 : suggestions de langue par courriel ----------
  const resendKey = env('RESEND_API_KEY', false), to = env('SUGGEST_EMAIL', false);
  if (resendKey && to) {
    const { data: sug, error: e4 } = await db.from('language_suggestions').select('id, language, created_at').is('emailed_at', null).order('created_at').limit(200);
    if (e4) throw e4;
    if (sug?.length) {
      const lines = sug.map((s) => `• ${s.language}  (${new Date(s.created_at).toLocaleString('fr-CA', { timeZone: 'America/Toronto' })})`).join('\n');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'YumTop <onboarding@resend.dev>', to: [to], subject: `YumTop : ${sug.length} suggestion(s) de langue`, text: `Nouvelles suggestions de langue dans YumTop :\n\n${lines}\n` })
      });
      if (!res.ok) throw new Error(`Courriel refusé (${res.status}) : ${(await res.text()).slice(0, 200)}`);
      await db.from('language_suggestions').update({ emailed_at: nowIso }).in('id', sug.map((s) => s.id));
      console.log(`${sug.length} suggestion(s) envoyée(s) par courriel`);
    }
  }
  console.log('Passage terminé.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main().catch((err) => { console.log('ERREUR : ' + hide(err)); process.exit(1); });
}
