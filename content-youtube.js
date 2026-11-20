// 재생목록 페이지에서 영상 URL 수집 (자동 스크롤 포함)
// 블록 스코프로 감쌈. 중복 주입 방지 플래그는 두지 않음:
// 확장 새로고침 후 죽은 옛 스크립트의 플래그가 새 주입을 막는 문제가 있었고,
// popup이 PING 실패 시에만 주입하므로 살아있는 리스너가 중복될 일은 없음.
{

  // 구 레이아웃(ytd-playlist-video-renderer)과 신 레이아웃(yt-lockup-view-model) 모두 지원
  const ITEM = 'ytd-playlist-video-renderer, yt-lockup-view-model';
  const LINK = 'ytd-playlist-video-renderer a#video-title, yt-lockup-view-model a[href*="/watch?v="]';

  async function extractUrls() {
    // 페이지 이동 직후엔 항목이 아직 없을 수 있으니 최대 10초 대기
    for (let w = 0; w < 50 && !document.querySelector(ITEM); w++) await new Promise((r) => setTimeout(r, 200));
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 100; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, 800));
      const n = document.querySelectorAll(ITEM).length;
      // 로딩 지연 대비: 두 번 연속 개수가 같을 때만 종료
      stable = n === last ? stable + 1 : 0;
      if (stable >= 2) break;
      last = n;
    }
    window.scrollTo(0, 0);

    const seen = new Set();
    const urls = [];
    const root = document.querySelector('ytd-browse[page-subtype="playlist"]') || document;
    for (const a of root.querySelectorAll(LINK)) {
      let id = null;
      try { id = new URL(a.href, location.origin).searchParams.get('v'); } catch (_) {}
      if (!id || seen.has(id)) continue; // 삭제/비공개 영상(링크 없음) 및 중복 제외
      seen.add(id);
      urls.push('https://www.youtube.com/watch?v=' + id);
    }
    return urls;
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === 'PING') { send({ ok: true }); return; }
    if (msg.type === 'EXTRACT_PLAYLIST') {
      if (location.pathname !== '/playlist') { send({ error: '재생목록 페이지(/playlist)가 아닙니다.' }); return; }
      extractUrls().then((urls) => send({ urls })).catch((e) => send({ error: String(e) }));
      return true;
    }
  });
}
