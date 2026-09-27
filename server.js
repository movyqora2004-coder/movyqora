import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 10000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: process.env.DATABASE_URL ? new (pgSession(session))({ pool, tableName: 'user_sessions', createTableIfMissing: true }) : undefined,
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 * 1024 } });

async function db(sql, params = []) { return pool.query(sql, params); }
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
  await db(schema);
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const exists = await db('SELECT id FROM users WHERE email=$1', [process.env.ADMIN_EMAIL.toLowerCase()]);
    if (!exists.rowCount) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await db('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)', [process.env.ADMIN_NAME || 'Admin', process.env.ADMIN_EMAIL.toLowerCase(), hash, 'admin']);
      console.log('Admin account created from environment variables.');
    }
  }
}

function auth(req, res, next) { if (!req.session.user) return res.redirect('/login'); next(); }
function role(...roles) { return (req, res, next) => { if (!req.session.user || !roles.includes(req.session.user.role)) return res.status(403).render('error', { user: req.session.user, message: 'You do not have permission to open this page.' }); next(); }; }
function setFlash(req, type, message) { req.session.flash = { type, message }; }
function baseView(req, extra = {}) { const flash = req.session.flash; delete req.session.flash; return { user: req.session.user || null, flash, ...extra }; }

app.get('/', auth, async (req,res) => {
  const q = String(req.query.q || '').trim();
  const normalized = q.toLowerCase();
  const typeMap = { movie: 'movie', movies: 'movie', series: 'series', 'web series': 'series', webseries: 'series', anime: 'anime' };
  const params = q ? [typeMap[normalized] || `%${q}%`] : [];
  const where = q ? (typeMap[normalized] ? 'WHERE t.type=$1' : 'WHERE t.title ILIKE $1 OR t.genre ILIKE $1') : '';
  const [top, trending, latest, all] = await Promise.all([
    db(`SELECT t.*, COUNT(l.user_id)::int likes FROM titles t LEFT JOIN likes l ON l.title_id=t.id GROUP BY t.id ORDER BY t.views DESC, t.created_at DESC LIMIT 10`),
    db(`SELECT t.* FROM titles t ORDER BY t.created_at DESC LIMIT 12`),
    db(`SELECT t.* FROM titles t ${where} ORDER BY t.created_at DESC LIMIT 24`, params),
    db(`SELECT DISTINCT genre FROM titles ORDER BY genre`)
  ]);
  res.render('home', baseView(req, { top: top.rows, trending: trending.rows, titles: latest.rows, genres: all.rows.map(x=>x.genre), q }));
});

app.get('/login', (req,res)=>res.render('auth', baseView(req, { mode:'login' })));
app.get('/signup', (req,res)=>res.render('auth', baseView(req, { mode:'signup' })));
app.post('/signup', async (req,res)=>{
  const {name,email,password} = req.body;
  if (!name || !email || !password || password.length < 6) { setFlash(req,'error','Name, email and a 6+ character password are required.'); return res.redirect('/signup'); }
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await db('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role', [name.trim(), email.trim().toLowerCase(), hash]);
    req.session.user = r.rows[0]; setFlash(req,'success',`Welcome ${name.trim()}!`); res.redirect('/');
  } catch(e) { setFlash(req,'error', e.code === '23505' ? 'Email is already registered.' : 'Signup failed.'); res.redirect('/signup'); }
});
app.post('/login', async (req,res)=>{
  const r = await db('SELECT * FROM users WHERE email=$1', [String(req.body.email||'').trim().toLowerCase()]);
  if (!r.rowCount || !(await bcrypt.compare(req.body.password || '', r.rows[0].password_hash))) { setFlash(req,'error','Invalid email or password.'); return res.redirect('/login'); }
  const u = r.rows[0]; delete u.password_hash; req.session.user = u; res.redirect('/');
});
app.post('/logout',(req,res)=>req.session.destroy(()=>res.redirect('/login')));

app.get('/upload', auth, role('admin','uploader'), async (req,res)=>{
  const genres = await db('SELECT DISTINCT genre FROM titles ORDER BY genre');
  res.render('upload', baseView(req,{genres:genres.rows.map(x=>x.genre)}));
});

app.post('/upload', auth, role('admin','uploader'), upload.fields([{name:'q360'},{name:'q480'},{name:'q720'},{name:'q1080'}]), async (req,res)=>{
  const {title,type,genre,year,description,poster_url,backdrop_url} = req.body;
  if (!title || !type || !genre) { setFlash(req,'error','Title, type and genre are required.'); return res.redirect('/upload'); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query('INSERT INTO titles(title,type,genre,year,description,poster_url,backdrop_url,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [title, type, genre, year || null, description || '', poster_url || '', backdrop_url || '', req.session.user.id]);
    const files = req.files || {};
    for (const [field,arr] of Object.entries(files)) {
      const quality = ({q360:'360p',q480:'480p',q720:'720p',q1080:'1080p'})[field];
      if (quality && arr[0]) await client.query('INSERT INTO videos(title_id,quality,filename,original_name,size_bytes,mime_type) VALUES($1,$2,$3,$4,$5,$6)', [t.rows[0].id,quality,arr[0].filename,arr[0].originalname,arr[0].size,arr[0].mimetype]);
    }
    await client.query('COMMIT');
    setFlash(req,'success','Content uploaded successfully and is now visible to users.'); res.redirect('/upload');
  } catch(e) { await client.query('ROLLBACK'); setFlash(req,'error','Upload failed: '+e.message); res.redirect('/upload'); } finally { client.release(); }
});

app.get('/watch/:id', auth, async (req,res)=>{
  const t = await db('SELECT t.*, COALESCE((SELECT COUNT(*) FROM likes WHERE title_id=t.id),0)::int AS likes, EXISTS(SELECT 1 FROM likes WHERE title_id=t.id AND user_id=$2) AS liked FROM titles t WHERE t.id=$1', [req.params.id, req.session.user.id]);
  if (!t.rowCount) return res.status(404).render('error',baseView(req,{message:'Title not found.'}));
  await db('UPDATE titles SET views=views+1 WHERE id=$1',[req.params.id]);
  const [videos, comments] = await Promise.all([
    db('SELECT id,quality,size_bytes FROM videos WHERE title_id=$1 ORDER BY split_part(quality,\'p\',1)::int DESC',[req.params.id]),
    db('SELECT c.*,u.name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.title_id=$1 ORDER BY c.created_at DESC LIMIT 100',[req.params.id])
  ]);
  res.render('watch',baseView(req,{title:t.rows[0],videos:videos.rows,comments:comments.rows}));
});
app.get('/video/:id/stream', auth, async (req,res)=>serveVideo(req,res,false));
app.get('/video/:id/download', auth, async (req,res)=>serveVideo(req,res,true));
async function serveVideo(req,res,download=false){
  const r = await db('SELECT v.*,t.title FROM videos v JOIN titles t ON t.id=v.title_id WHERE v.id=$1',[req.params.id]);
  if(!r.rowCount) return res.sendStatus(404);
  const v=r.rows[0], file=path.join(uploadDir,v.filename);
  if(!fs.existsSync(file)) return res.status(404).send('Video file not found on server.');
  const stat=fs.statSync(file), range=req.headers.range;
  res.setHeader('Accept-Ranges','bytes'); res.setHeader('Content-Type',v.mime_type || 'video/mp4');
  if(download) res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(v.original_name || v.title)}"`);
  if(!range){res.setHeader('Content-Length',stat.size); return fs.createReadStream(file).pipe(res);}
  const [startStr,endStr]=range.replace(/bytes=/,'').split('-'); const start=parseInt(startStr,10); const end=endStr?parseInt(endStr,10):stat.size-1; const chunk=end-start+1;
  res.status(206); res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`); res.setHeader('Content-Length',chunk); fs.createReadStream(file,{start,end}).pipe(res);
}

app.post('/api/titles/:id/view', auth, async (req,res)=>{ await db('UPDATE titles SET views=views+1 WHERE id=$1',[req.params.id]); res.json({ok:true}); });
app.post('/api/titles/:id/like', auth, async (req,res)=>{
  const exists=await db('SELECT 1 FROM likes WHERE user_id=$1 AND title_id=$2',[req.session.user.id,req.params.id]);
  if(exists.rowCount) await db('DELETE FROM likes WHERE user_id=$1 AND title_id=$2',[req.session.user.id,req.params.id]); else await db('INSERT INTO likes(user_id,title_id) VALUES($1,$2)',[req.session.user.id,req.params.id]);
  const count=await db('SELECT COUNT(*)::int count FROM likes WHERE title_id=$1',[req.params.id]); res.json({liked:!exists.rowCount,likes:count.rows[0].count});
});
app.post('/api/titles/:id/comments', auth, async (req,res)=>{ const body=String(req.body.body||'').trim(); if(!body) return res.status(400).json({error:'Comment is empty'}); const r=await db('INSERT INTO comments(user_id,title_id,body) VALUES($1,$2,$3) RETURNING id,body,created_at',[req.session.user.id,req.params.id,body]); res.json({comment:{...r.rows[0],name:req.session.user.name}}); });

app.get('/admin', auth, role('admin'), async (req,res)=>{
  const [stats,users,titles] = await Promise.all([
    db(`SELECT (SELECT COUNT(*) FROM titles)::int total_titles,(SELECT COUNT(*) FROM titles WHERE type='movie')::int movies,(SELECT COUNT(*) FROM titles WHERE type='series')::int series,(SELECT COUNT(*) FROM titles WHERE type='anime')::int anime,(SELECT COALESCE(SUM(views),0)::bigint FROM titles) total_views,(SELECT COUNT(*) FROM likes)::int total_likes,(SELECT COUNT(*) FROM comments)::int total_comments`),
    db('SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC'),
    db('SELECT t.*,u.name uploader,(SELECT COUNT(*) FROM comments c WHERE c.title_id=t.id)::int comments,(SELECT COUNT(*) FROM likes l WHERE l.title_id=t.id)::int likes FROM titles t LEFT JOIN users u ON u.id=t.uploaded_by ORDER BY t.created_at DESC')
  ]);
  res.render('admin',baseView(req,{stats:stats.rows[0],users:users.rows,titles:titles.rows}));
});
app.post('/admin/users/:id/role', auth, role('admin'), async(req,res)=>{ const roleVal=['user','uploader'].includes(req.body.role)?req.body.role:'user'; await db('UPDATE users SET role=$1 WHERE id=$2 AND role<>\'admin\'',[roleVal,req.params.id]); setFlash(req,'success','User role updated.'); res.redirect('/admin'); });
app.post('/admin/titles/:id/delete', auth, role('admin'), async(req,res)=>{ const vids=await db('SELECT filename FROM videos WHERE title_id=$1',[req.params.id]); for(const v of vids.rows){try{fs.unlinkSync(path.join(uploadDir,v.filename));}catch{}} await db('DELETE FROM titles WHERE id=$1',[req.params.id]); setFlash(req,'success','Content deleted.'); res.redirect('/admin'); });

app.get('/healthz', (req,res) => res.json({ ok:true, service:'movyqora' }));
app.use((req,res)=>res.status(404).render('error',baseView(req,{message:'Page not found.'})));

init().then(()=>{
  const server = app.listen(PORT,()=>console.log(`Movyqora running on port ${PORT}`));
  // Large video uploads can legitimately take longer than Node's default request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
}).catch(err=>{console.error(err);process.exit(1)});
