const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };

let items = []; // { key, url, title, checked }

// ---------- 저장/복원 (팝업은 포커스를 잃으면 닫히므로 목록을 보존) ----------
async function persist() {
  await chrome.storage.local.set({ popupItems: items, sourceLimit: Number($('limit').value) || 300 });
}

// ---------- URL 정규화 ----------
// YouTube(영상/shorts/live/embed/youtu.be)는 watch?v=ID 로 통일, 그 외 http(s) URL은 그대로 사용
function normalizeUrl(raw) {
  const s = raw.trim().replace(/[)\],.;'"]+$/, '');
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtube.com') {
    if (u.pathname === '/playlist') return { playlist: true };
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
      if (m) id = m[2];
    }
  } else if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0];
  }
  if (id) return { key: id, url: 'https://www.youtube.com/watch?v=' + id };
  return { key: u.href, url: u.href };
}

function addItems(list) {
  const have = new Set(items.map((i) => i.key));
  let added = 0;
  for (const it of list) {
    if (have.has(it.key)) continue;
    have.add(it.key);
    items.push({ key: it.key, url: it.url, title: it.title || it.url, checked: true });
    added++;
  }
  return added;
}

// ---------- 목록 렌더링 ----------
function render() {
  const box = $('list');
  box.textContent = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.id = 'empty';
    d.textContent = '목록이 비어 있습니다.';
    box.appendChild(d);
  }
  items.forEach((it, idx) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.checked;
    cb.addEventListener('change', () => { it.checked = cb.checked; updateSummary(); persist(); });
    const t = document.createElement('div');
    t.className = 't';
    t.title = it.url;
    t.textContent = `${idx + 1}. ${it.title}`;
    label.append(cb, t);
    box.appendChild(label);
  });
  updateSummary();
}

function updateSummary() {
  const n = items.filter((i) => i.checked).length;
  $('count').textContent = `${n} / ${items.length}`;
  $('hcount').textContent = `${items.length}개`;
  $('send').textContent = n ? `${n}개 NotebookLM으로 보내기` : '선택한 항목 NotebookLM으로 보내기';
  $('all').checked = items.length > 0 && n === items.length;
  $('send').disabled = n === 0;
}

// ---------- 페이지 안에서 실행되는 추출 함수 (직렬화되어 주입: 외부 변수 참조 금지) ----------
async function extractInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 구 레이아웃(ytd-playlist-video-renderer)과 신 레이아웃(yt-lockup-view-model) 모두 지원
  const ITEM = 'ytd-playlist-video-renderer, yt-lockup-view-model';
  const LINK = 'ytd-playlist-video-renderer a#video-title, yt-lockup-view-model a[href*="/watch?v="]';
  const rootOf = () => document.querySelector('ytd-browse[page-subtype="playlist"]') || document;

  for (let w = 0; w < 50 && !rootOf().querySelector(ITEM); w++) await sleep(200);
  let last = -1, stable = 0;
  for (let i = 0; i < 100; i++) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(800);
    const n = rootOf().querySelectorAll(ITEM).length;
    stable = n === last ? stable + 1 : 0;
    if (stable >= 2) break;
    last = n;
  }
  window.scrollTo(0, 0);

  const root = rootOf();
  const titles = new Map(); // id -> title (썸네일 링크는 제목이 비어 있어 비어있지 않은 값을 우선)
  const order = [];
  for (const a of root.querySelectorAll(LINK)) {
    let id = null;
    try { id = new URL(a.href, location.origin).searchParams.get('v'); } catch (_) {}
    if (!id) continue; // 삭제/비공개(링크 없음) 제외
    // 제목 링크(h3 안 / 구 레이아웃 #video-title)의 텍스트만 제목으로 사용. 썸네일 링크 텍스트는 영상 길이("26:01")라 제외
    const isTitleLink = a.id === 'video-title' || !!a.closest('h3');
    const t = isTitleLink ? (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!titles.has(id)) { titles.set(id, t); order.push(id); }
    else if (!titles.get(id) && t) titles.set(id, t);
  }
  return {
    items: order.map((id) => ({ id, title: titles.get(id) || id })),
    diag: {
      path: location.pathname,
      items: root.querySelectorAll(ITEM).length,
      links: root.querySelectorAll(LINK).length,
      watchLinks: root.querySelectorAll('a[href*="/watch?v="]').length,
    },
  };
}

// ---------- 현재 페이지에서 불러오기 ----------
$('load').addEventListener('click', async () => {
  $('load').disabled = true;
  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let u = null;
    try { u = new URL(tab.url); } catch (_) {}
    if (!u || u.hostname !== 'www.youtube.com') {
      setStatus('유튜브 페이지가 아닙니다. 아래에 URL을 직접 입력할 수 있습니다.');
      return;
    }
    const list = u.searchParams.get('list');

    // 재생 페이지(list= 포함)면 재생목록 페이지로 이동 후 진행
    if (u.pathname === '/watch' && list) {
      setStatus('재생목록 페이지로 이동 중...');
      await chrome.tabs.update(tab.id, { url: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` });
      await new Promise((resolve) => {
        const onUpdated = (id, info) => {
          if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 15000);
      });
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      u = new URL(tab.url);
    }

    // 개별 영상 페이지 (재생목록 없음): 현재 영상 1개
    if (u.pathname === '/watch' || /^\/(shorts|live)\//.test(u.pathname)) {
      const n = normalizeUrl(tab.url);
      const title = (tab.title || '').replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '').trim();
      const added = addItems([{ ...n, title }]);
      setStatus(added ? `현재 영상 1개를 목록에 추가했습니다.` : '이미 목록에 있는 영상입니다.');
      return;
    }

    if (u.pathname !== '/playlist') {
      setStatus('재생목록(/playlist) 또는 영상 페이지에서 실행하세요. 아래에 URL을 직접 입력할 수도 있습니다.');
      return;
    }

    setStatus('불러오는 중... (스크롤하며 로딩)');
    // content script 메시지 대신 함수를 직접 주입: 항상 최신 코드가 실행됨
    const [{ result: res } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractInPage });
    if (!res) throw new Error('페이지에서 응답이 없습니다.');
    if (!res.items.length) {
      const d = res.diag;
      setStatus(`추출된 URL이 없습니다. (진단: ${d.path} / 항목 ${d.items} / 링크 ${d.links} / watch링크 ${d.watchLinks})`);
      return;
    }
    const added = addItems(res.items.map((x) => ({ key: x.id, url: 'https://www.youtube.com/watch?v=' + x.id, title: x.title })));
    setStatus(`${res.items.length}개 불러옴 (새로 추가 ${added}개). 보낼 항목을 고르세요.`);
  } catch (e) {
    console.error(e);
    setStatus('오류: ' + e.message);
  } finally {
    $('load').disabled = false;
    render();
    persist();
  }
});

// ---------- 직접 입력 ----------
$('addManual').addEventListener('click', () => {
  const found = $('manual').value.match(/https?:\/\/[^\s<>"']+/g) || [];
  let skippedPlaylist = 0;
  const list = [];
  for (const raw of found) {
    const n = normalizeUrl(raw);
    if (!n) continue;
    if (n.playlist) { skippedPlaylist++; continue; }
    list.push(n);
  }
  const added = addItems(list);
  let msg = found.length ? `${list.length}개 인식, 새로 추가 ${added}개.` : 'http(s):// 로 시작하는 URL을 찾지 못했습니다.';
  if (skippedPlaylist) msg += `\n재생목록 URL ${skippedPlaylist}개는 해당 재생목록 페이지에서 "불러오기"를 사용하세요.`;
  setStatus(msg);
  if (added) $('manual').value = '';
  render();
  persist();
});

// ---------- 목록 조작 / 보내기 ----------
$('all').addEventListener('change', () => {
  items.forEach((i) => { i.checked = $('all').checked; });
  render();
  persist();
});
$('clear').addEventListener('click', () => { items = []; render(); persist(); setStatus('목록을 비웠습니다.'); });
$('limit').addEventListener('change', persist);

$('send').addEventListener('click', async () => {
  const chosen = items.filter((i) => i.checked).map(({ key, url, title }) => ({ key, url, title }));
  if (!chosen.length) return;
  $('send').disabled = true;
  try {
    await persist();
    await chrome.runtime.sendMessage({ type: 'SEND_TO_NOTEBOOKLM', items: chosen, limit: Number($('limit').value) || 300 });
    setStatus(`${chosen.length}개 전달 완료.\nNotebookLM에서 노트북을 열고 우측 하단 파란 버튼을 누르세요.`);
  } catch (e) {
    setStatus('오류: ' + e.message);
  } finally {
    updateSummary();
  }
});

// ---------- 초기화 ----------
(async () => {
  const { popupItems = [], sourceLimit = 300 } = await chrome.storage.local.get(['popupItems', 'sourceLimit']);
  items = popupItems;
  $('limit').value = sourceLimit;
  render();
})();
