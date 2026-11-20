// 추출된 URL을 저장하고 NotebookLM 탭을 열거나 찾아서 포커스한다.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'SEND_TO_NOTEBOOKLM') return;
  (async () => {
    await chrome.storage.local.set({ pendingUrls: msg.urls });
    // NotebookLM이 notebook.google.com(Gemini Notebook)으로 이전/리다이렉트되는 경우도 대응
    const tabs = await chrome.tabs.query({
      url: ['https://notebooklm.google.com/*', 'https://notebook.google.com/*'],
    });
    if (tabs.length) {
      // 확장 설치/새로고침 전에 열린 탭에는 content script가 없으므로 수동 주입
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' });
      } catch (_) {
        await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content-notebooklm.js'] });
      }
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: 'https://notebooklm.google.com/' });
    }
  })();
});
