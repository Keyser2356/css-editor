browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'TO_TAB') {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) return browser.tabs.sendMessage(tabs[0].id, msg.payload);
  }
});
