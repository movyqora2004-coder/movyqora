const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

async function notify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission === 'granted') new Notification(title, { body });
  } catch {}
}

// Mobile-friendly menu.
const menuBtn = $('#menuBtn');
const mobileMenu = $('#mobileMenu');
menuBtn?.addEventListener('click', () => mobileMenu?.classList.toggle('open'));

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 2 : 0)} ${units[i]}`;
}
function formatSpeed(bytesPerSecond) { return `${formatBytes(bytesPerSecond)}/s`; }
function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}
function setProgress(el, pct) { if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`; }

// Upload progress: size, percentage, speed, remaining and ETA.
const uploadForm = $('#uploadForm');
if (uploadForm) {
  uploadForm.addEventListener('submit', e => {
    e.preventDefault();
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    let lastLoaded = 0, lastTime = started;
    xhr.open('POST', uploadForm.action);
    xhr.upload.onprogress = ev => {
      if (!ev.lengthComputable) return;
      const now = performance.now();
      const elapsed = (now - started) / 1000;
      const deltaTime = Math.max((now - lastTime) / 1000, 0.001);
      const instantSpeed = (ev.loaded - lastLoaded) / deltaTime;
      const avgSpeed = ev.loaded / Math.max(elapsed, 0.001);
      const pct = ev.loaded / ev.total * 100;
      const remaining = ev.total - ev.loaded;
      setProgress($('#uploadProgress'), pct);
      const stats = $('#uploadStats');
      if (stats) stats.textContent = `${formatBytes(ev.loaded)} / ${formatBytes(ev.total)} · ${pct.toFixed(1)}% · ${formatSpeed((instantSpeed + avgSpeed) / 2)} · ${formatBytes(remaining)} left · ETA ${formatEta(remaining / Math.max((instantSpeed + avgSpeed) / 2, 1))}`;
      lastLoaded = ev.loaded; lastTime = now;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 400) {
        setProgress($('#uploadProgress'), 100);
        if ($('#uploadStats')) $('#uploadStats').textContent = 'Upload complete · Content is now live for users.';
        notify('MOVYQORA', 'Upload complete — your content is now live.');
        setTimeout(() => { location.href = '/upload'; }, 500);
      } else {
        notify('MOVYQORA', 'Upload failed.');
        alert('Upload failed. Check the server log for details.');
      }
    };
    xhr.onerror = () => { notify('MOVYQORA', 'Network error during upload.'); alert('Network error during upload.'); };
    xhr.send(new FormData(uploadForm));
    notify('MOVYQORA', 'Upload started. Keep this page open until it finishes.');
  });
}

if (window.TITLE_ID) {
  const q = $('#quality'), player = $('#player'), like = $('#likeBtn'), download = $('#downloadBtn');

  q?.addEventListener('change', () => {
    const cur = player.currentTime;
    player.src = `/video/${q.value}/stream`;
    player.load();
    player.currentTime = cur;
    player.play().catch(() => {});
  });

  like?.addEventListener('click', async () => {
    const r = await fetch(`/api/titles/${TITLE_ID}/like`, { method: 'POST' });
    const d = await r.json();
    if (d.error) return;
    $('#likeCount').textContent = d.likes;
    like.classList.toggle('gold', d.liked);
  });

  // Native download is used for large files so the browser/Android download manager can
  // handle the file without loading a multi-GB video into page memory.
  download?.addEventListener('click', () => {
    const id = q?.value;
    if (!id) return;
    const selected = window.VIDEOS?.find(v => String(v.id) === String(id));
    notify('MOVYQORA', `Download started · ${selected ? formatBytes(Number(selected.size_bytes)) : 'video file'}`);
    const a = document.createElement('a');
    a.href = `/video/${id}/download`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  });

  $('#commentForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const body = $('#commentBody').value.trim();
    if (!body) return;
    const r = await fetch(`/api/titles/${TITLE_ID}/comments`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({body})
    });
    const d = await r.json();
    if (d.comment) {
      const a = document.createElement('article');
      a.innerHTML = `<b>${escapeHtml(d.comment.name)}</b><small>just now</small><p>${escapeHtml(d.comment.body)}</p>`;
      $('#commentList').prepend(a); $('#commentBody').value = '';
    }
  });
}

function escapeHtml(s) { return s.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
