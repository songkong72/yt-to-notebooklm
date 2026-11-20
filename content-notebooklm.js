// ===== 설정: NotebookLM UI가 바뀌면 여기만 수정 =====
const CONFIG = {
  BATCH_SIZE: 10,          // "웹사이트 및 YouTube URL" 창은 공백/줄바꿈 구분으로 여러 URL 허용 (검증됨)
  TIMEOUT_MS: 15000,
  DEFAULT_LIMIT: 50,       // 소스 한도 기본값 (무료 50 / Plus 100 / Pro 300)
  LABELS: {
    sourcesTab: /^sources$|^소스$/i,       // 좁은 화면에서 Sources/채팅/Studio 탭 전환용
    addSource: /소스 추가|출처 추가|add sources?/i,
    // 2026-11 기준 별도 YouTube 버튼이 없고 "웹사이트" 하나가 웹+YouTube URL을 모두 받음
    youtube: /웹사이트|website|youtube|유튜브/i,
    insert: /^(삽입|insert)$/i,
  },
  CLICKABLE: 'button, [role="button"], [role="tab"], [role="menuitem"], mat-chip, a',
  DIALOG: '[role="dialog"], mat-dialog-container',
  INPUT: 'textarea, input[type="text"], input[type="url"], input:not([type])',
  // 첫 화면에도 "웹에서 검색" textarea가 있어서, URL 입력창만 골라내기 위한 힌트
  INPUT_HINT: /링크|url|link/i,
};
// ====================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = CONFIG.TIMEOUT_MS) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

// position:fixed 요소는 offsetParent가 null이므로 rect로 가시성 판단
const isVisible = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

// 아이콘 ligature 텍스트(예: "add")를 제외한 순수 라벨 후보들
function labelsOf(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('mat-icon, .material-icons, .google-symbols, [class*="icon"]').forEach((n) => n.remove());
  return [el.getAttribute('aria-label'), clone.textContent]
    .map((s) => (s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';

function findClickable(regex, root = document) {
  return [...root.querySelectorAll(CONFIG.CLICKABLE)].find(
    (el) => !isDisabled(el) && isVisible(el) && labelsOf(el).some((l) => regex.test(l))
  );
}

const getDialog = () => [...document.querySelectorAll(CONFIG.DIALOG)].find(isVisible);

function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function addBatch(urls, log) {
  let addBtn = findClickable(CONFIG.LABELS.addSource);
  if (!addBtn) {
    // 좁은 화면: Sources 탭을 눌러야 "소스 추가"가 보임
    const tab = findClickable(CONFIG.LABELS.sourcesTab);
    if (tab) tab.click();
    addBtn = await waitFor(() => findClickable(CONFIG.LABELS.addSource));
  }
  if (!addBtn) throw new Error('"소스 추가" 버튼을 못 찾음 (노트북 화면인지 확인)');
  addBtn.click();

  const dialog = await waitFor(getDialog);
  if (!dialog) throw new Error('소스 추가 창이 안 열림');

  const ytBtn = await waitFor(() => findClickable(CONFIG.LABELS.youtube, getDialog() || document));
  if (!ytBtn) throw new Error('YouTube 옵션을 못 찾음');
  ytBtn.click();

  const input = await waitFor(() =>
    [...(getDialog() || document).querySelectorAll(CONFIG.INPUT)].find(
      (el) => isVisible(el) && CONFIG.INPUT_HINT.test(`${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`)
    )
  );
  if (!input) throw new Error('URL 입력창을 못 찾음');
  input.focus();
  setNativeValue(input, urls.join('\n'));
  await sleep(500);

  const insertBtn = await waitFor(() => findClickable(CONFIG.LABELS.insert, getDialog() || document));
  if (!insertBtn) throw new Error('"삽입" 버튼을 못 찾음');
  insertBtn.click();

  const closed = await waitFor(() => !getDialog(), 30000);
  if (!closed) throw new Error('삽입 후 창이 닫히지 않음 (URL 형식/한도 확인)');
  await sleep(2000);
  log(`${urls.length}개 추가 요청 완료`);
}

// ---------- 중복/한도 처리 ----------
const normTitle = (s) => (s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const notebookId = () => (location.pathname.match(/\/notebook\/([^/?#]+)/) || [])[1] || null;

// 노트북에 이미 있는 소스 제목 (".single-source-container .source-title"; Gemini 채팅 그룹 행은 .source-title이 없어 제외됨)
async function readExistingSources() {
  const read = () => [...document.querySelectorAll('.single-source-container .source-title')].map((e) => e.textContent);
  let titles = read();
  if (!titles.length) {
    // 좁은 화면에서는 Sources 탭을 눌러야 목록이 렌더링됨
    const tab = findClickable(CONFIG.LABELS.sourcesTab);
    if (tab) { tab.click(); await sleep(1200); titles = read(); }
  }
  return titles;
}

async function run(setStatus) {
  const nbId = notebookId();
  if (!nbId) return setStatus('노트북을 먼저 여세요 (목록 화면에서는 추가할 수 없음)');

  const { pendingItems = [], addedHistory = {}, sourceLimit = CONFIG.DEFAULT_LIMIT } =
    await chrome.storage.local.get(['pendingItems', 'addedHistory', 'sourceLimit']);
  if (!pendingItems.length) return setStatus('추가할 항목이 없습니다.');

  // 1) 중복 제외: 이 노트북에 확장으로 추가한 이력(key) + 화면의 기존 소스 제목
  const history = new Set(addedHistory[nbId] || []);
  const existingTitles = await readExistingSources();
  const existingSet = new Set(existingTitles.map(normTitle));
  const fresh = [];
  let dup = 0;
  for (const it of pendingItems) {
    const titleKnown = it.title && it.title !== it.url;
    if (history.has(it.key) || (titleKnown && existingSet.has(normTitle(it.title)))) dup++;
    else fresh.push(it);
  }

  // 2) 소스 한도: 현재 소스 수(화면 우선, 없으면 이력) + 추가분 <= 한도
  const existingCount = existingTitles.length || history.size;
  const room = Math.max(0, sourceLimit - existingCount);
  const queue = fresh.slice(0, room);
  const overflow = fresh.slice(room);
  const notes = [];
  if (dup) notes.push(`중복 ${dup}개 제외`);
  if (overflow.length) notes.push(`한도(${sourceLimit}) 초과로 ${overflow.length}개 보류`);

  if (!queue.length) {
    await chrome.storage.local.set({ pendingItems: overflow });
    return setStatus(`추가할 새 항목 없음${notes.length ? ' (' + notes.join(', ') + ')' : ''}`);
  }

  const total = queue.length;
  let remaining = queue.slice();
  const flushPending = (rest) =>
    rest.length || overflow.length
      ? chrome.storage.local.set({ pendingItems: [...rest, ...overflow] })
      : chrome.storage.local.remove('pendingItems');
  await flushPending(remaining);

  while (remaining.length) {
    const batch = remaining.slice(0, CONFIG.BATCH_SIZE);
    setStatus(`${total - remaining.length + batch.length} / ${total} 처리 중...${notes.length ? ' (' + notes.join(', ') + ')' : ''}`);
    try {
      await addBatch(batch.map((b) => b.url), console.log);
    } catch (e) {
      console.error('[yt-to-notebooklm]', e);
      await flushPending(remaining); // 실패한 배치 + 시도 안 한 나머지 보존
      return setStatus(`오류: ${e.message} (남은 ${remaining.length + overflow.length}개, 클릭하여 재시도)`);
    }
    // 성공분: 이력에 기록하고 대기열에서 제거 (중단/재시도 시 중복 방지)
    batch.forEach((b) => history.add(b.key));
    addedHistory[nbId] = [...history];
    await chrome.storage.local.set({ addedHistory });
    remaining = remaining.slice(batch.length);
    await flushPending(remaining);
  }
  setStatus(`${total}개 추가 완료${notes.length ? ' (' + notes.join(', ') + ')' : ''}`);
}

// 화면 우측 하단 버튼 + 안내 말풍선 (위치는 예전과 같은 오른쪽 아래)
function mountButton() {
  // 확장 새로고침/재주입으로 남은 옛 버튼 제거
  document.getElementById('yt2nlm-wrap')?.remove();
  document.getElementById('yt2nlm-btn')?.remove();

  const wrap = document.createElement('div');
  wrap.id = 'yt2nlm-wrap';
  wrap.style.cssText =
    'position:fixed;right:24px;bottom:110px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-family:"Noto Sans KR","Malgun Gothic",sans-serif';

  // 안내 말풍선
  const tip = document.createElement('div');
  tip.style.cssText =
    'position:relative;width:250px;box-sizing:border-box;padding:10px 12px;border-radius:10px;background:#1e293b;color:#fff;font-size:13px;font-weight:500;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.4);display:none';
  const tipText = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.style.cssText = 'position:absolute;right:36px;bottom:-6px;width:12px;height:12px;background:#1e293b;transform:rotate(45deg)';
  tip.append(tipText, arrow);

  const btn = document.createElement('button');
  btn.id = 'yt2nlm-btn';
  wrap.append(tip, btn);
  (document.body || document.documentElement).appendChild(wrap);

  const BASE = 'border:0;border-radius:8px;color:#fff;cursor:pointer;';
  // ready: 보낸 영상이 있어 눈에 띄게 / busy: 작업 중·결과 표시 / idle: 대기
  const STYLES = {
    ready: BASE + 'padding:12px 18px;background:#1a73e8;font:600 15px "Noto Sans KR","Malgun Gothic",sans-serif;box-shadow:0 0 0 6px rgba(26,115,232,.25),0 2px 8px rgba(0,0,0,.4)',
    busy: BASE + 'padding:10px 14px;background:#1a73e8;font:14px "Noto Sans KR","Malgun Gothic",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)',
    idle: BASE + 'padding:10px 14px;background:#5f6368;font:14px "Noto Sans KR","Malgun Gothic",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)',
  };
  const setMode = (mode, text, tipMessage) => {
    btn.style.cssText = STYLES[mode];
    btn.textContent = text;
    if (tipMessage) { tipText.textContent = tipMessage; tip.style.display = 'block'; }
    else tip.style.display = 'none';
  };

  let running = false;
  let tipDismissed = false;
  // run()이 쓰는 상태 표시 (작업 중/결과)
  const setStatus = (t) => setMode('busy', t, null);
  const refresh = async () => {
    if (running) return;
    const { pendingItems = [] } = await chrome.storage.local.get('pendingItems');
    if (pendingItems.length) {
      const n = pendingItems.length;
      setMode('ready', `${n}개를 소스로 추가하기`, tipDismissed ? null : `이 버튼을 누르면 보낸 영상 ${n}개가 이 노트북의 소스로 추가돼요.`);
    } else {
      // 숨기지 않고 대기 상태를 표시 (확장이 이 페이지에 로드됐는지 바로 확인 가능)
      setMode('idle', '추가할 URL 없음', null);
    }
  };
  btn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    tipDismissed = true;
    tip.style.display = 'none';
    try {
      await run(setStatus);
    } catch (e) {
      console.error('[yt-to-notebooklm]', e);
      setStatus(`오류: ${e.message}`);
    } finally {
      running = false;
    }
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pendingItems) {
      // 새로 보낸 항목이 들어오면 말풍선을 다시 보여줌 (남은 항목이 줄어드는 경우는 제외)
      const added = (changes.pendingItems.newValue || []).length > (changes.pendingItems.oldValue || []).length;
      if (added) tipDismissed = false;
      refresh();
    }
  });
  refresh();
}
mountButton();
