const statusEl = document.getElementById('status');
const btn = document.getElementById('extract');
const setStatus = (t) => { statusEl.textContent = t; };

// 페이지 안에서 실행되는 함수 (직렬화되어 주입되므로 외부 변수 참조 금지, 자체 완결)
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
  const seen = new Set();
  const urls = [];
  for (const a of root.querySelectorAll(LINK)) {
    let id = null;
    try { id = new URL(a.href, location.origin).searchParams.get('v'); } catch (_) {}
    if (!id || seen.has(id)) continue; // 삭제/비공개(링크 없음) 및 중복 제외
    seen.add(id);
    urls.push('https://www.youtube.com/watch?v=' + id);
  }
  return {
    urls,
    diag: {
      path: location.pathname,
      items: root.querySelectorAll(ITEM).length,
      links: root.querySelectorAll(LINK).length,
      watchLinks: root.querySelectorAll('a[href*="/watch?v="]').length,
    },
  };
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let u = null;
    try { u = new URL(tab.url); } catch (_) {}
    if (!u || u.hostname !== 'www.youtube.com') {
      setStatus('유튜브 재생목록 페이지에서 실행하세요.');
      return;
    }
    // 재생 페이지(/watch?v=..&list=..)면 재생목록 페이지로 이동 후 진행
    const list = u.searchParams.get('list');
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
    } else if (u.pathname !== '/playlist') {
      setStatus('재생목록이 있는 페이지(/playlist 또는 list= 포함 재생 페이지)에서 실행하세요.');
      return;
    }
    setStatus('추출 중... (스크롤하며 로딩)');
    // content script 메시지 대신 추출 함수를 직접 주입: 항상 최신 코드가 실행되고 옛 스크립트 잔존 문제가 없음
    const [{ result: res } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractInPage,
    });
    if (!res) throw new Error('페이지에서 응답이 없습니다.');
    if (!res.urls.length) {
      const d = res.diag;
      setStatus(`추출된 URL이 없습니다. (진단: ${d.path} / 항목 ${d.items} / 링크 ${d.links} / watch링크 ${d.watchLinks})`);
      return;
    }
    setStatus(`${res.urls.length}개 URL 추출됨 → NotebookLM으로 전달`);
    await chrome.runtime.sendMessage({ type: 'SEND_TO_NOTEBOOKLM', urls: res.urls });
    setStatus(`${res.urls.length}개 전달 완료. NotebookLM에서 노트북을 열고 우측 하단 버튼을 누르세요.`);
  } catch (e) {
    console.error(e);
    setStatus('오류: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});
