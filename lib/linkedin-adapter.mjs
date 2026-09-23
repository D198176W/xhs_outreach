import { createTab } from './cdp.mjs';

const NEED_HUMAN_RE = /(captcha|security check|verify|verification|sign in|join now|unusual activity|challenge|login)/i;

const pageScript = `
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fire = (el, type) => el && el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  const textOf = el => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const descriptorOf = el => [
    textOf(el),
    el && el.getAttribute && (el.getAttribute('aria-label') || ''),
    el && el.getAttribute && (el.getAttribute('title') || ''),
    el && el.getAttribute && (el.getAttribute('placeholder') || ''),
    el && el.className || '',
    el && el.id || ''
  ].join(' ');
  const isVisible = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clickEl = el => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    fire(el, 'mouseover');
    fire(el, 'mousedown');
    fire(el, 'mouseup');
    fire(el, 'click');
  };
  const findProfileName = () => (
    document.querySelector('h1') ||
    document.querySelector('.text-heading-xlarge') ||
    document.querySelector('[class*="profile"] h1')
  )?.textContent?.trim() || '';
  const findMessageButton = () => {
    const candidates = [
      ...document.querySelectorAll('button, a, [role="button"]')
    ].filter(isVisible);
    return candidates.find(el => {
      const text = descriptorOf(el);
      if (!/\\bMessage\\b|\\u53d1\\u6d88\\u606f|\\u53d1\\u9001\\u6d88\\u606f/i.test(text)) return false;
      if (/Messaging|Sponsored|Conversation|\\u6d88\\u606f\\u4e2d\\u5fc3|\\u5bf9\\u8bdd|\\u5e7f\\u544a/i.test(textOf(el))) return false;
      const rect = el.getBoundingClientRect();
      return rect.top > 80 && rect.top < window.innerHeight * 0.85;
    }) || candidates.find(el => /\\bMessage\\b|\\u53d1\\u6d88\\u606f|\\u53d1\\u9001\\u6d88\\u606f/i.test(descriptorOf(el)));
  };
  const findMessageDialog = () => {
    const dialogs = [
      ...document.querySelectorAll('[role="dialog"], [class*="msg-overlay"], [class*="message"], [class*="artdeco-modal"]')
    ].filter(isVisible);
    return dialogs
      .map(el => ({ el, rect: el.getBoundingClientRect(), text: textOf(el) }))
      .filter(item => /New message|Write a message|Send|Message|\\u65b0\\u6d88\\u606f|\\u5199\\u6d88\\u606f|\\u53d1\\u9001|\\u53d1\\u6d88\\u606f/i.test(item.text))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.el || null;
  };
  const waitForDialog = async () => {
    for (let i = 0; i < 24; i++) {
      const dialog = findMessageDialog();
      if (dialog) return dialog;
      await sleep(500);
    }
    return null;
  };
  const findEditor = root => {
    const scope = root || document;
    const editors = [
      ...scope.querySelectorAll('[contenteditable="true"]'),
      ...scope.querySelectorAll('textarea')
    ].filter(isVisible);
    return editors.find(el => /Write a message|message|\\u5199\\u6d88\\u606f|\\u8f93\\u5165\\u6d88\\u606f/i.test(descriptorOf(el)) || textOf(el).length < 200) || editors[0] || null;
  };
  const findSendButton = root => {
    const scope = root || document;
    const buttons = [...scope.querySelectorAll('button, [role="button"]')].filter(isVisible);
    return buttons.find(el => /^(Send|\\u53d1\\u9001)$/i.test(textOf(el)) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      || buttons.find(el => /Send|\\u53d1\\u9001/i.test(descriptorOf(el)) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  };
  const openMessageDialog = async () => {
    let dialog = findMessageDialog();
    if (dialog && findEditor(dialog)) return { ok: true, clicked: false, dialog };
    const button = findMessageButton();
    if (!button) return { ok: false, reason: 'LinkedIn Message button not found' };
    clickEl(button);
    dialog = await waitForDialog();
    if (!dialog) return { ok: false, reason: 'LinkedIn message dialog not found after clicking Message' };
    return { ok: true, clicked: true, dialog };
  };
`;

function hasNeedHuman(snapshot) {
  return NEED_HUMAN_RE.test(`${snapshot.title || ''} ${snapshot.text || ''} ${snapshot.url || ''}`);
}

export async function openAndReadProfile(profileUrl) {
  const cdp = await createTab({ url: profileUrl });
  try {
    await cdp.navigate(profileUrl);
    const snapshot = await cdp.evalJs(`(async () => {
      ${pageScript}
      const text = textOf(document.body);
      const opener = await openMessageDialog();
      return {
        url: location.href,
        title: document.title || '',
        name: findProfileName(),
        text: text.slice(0, 3000),
        opener: { ok: opener.ok, clicked: opener.clicked || false, reason: opener.reason || '' }
      };
    })()`);
    return {
      ok: true,
      needHuman: hasNeedHuman(snapshot),
      displayName: snapshot.name || snapshot.title.replace(/ \| .*/, ''),
      chatUrl: snapshot.url || profileUrl,
      snapshot
    };
  } finally {
    cdp.close();
  }
}

export async function readConversation(entryUrl) {
  return {
    ok: true,
    needHuman: false,
    reason: 'LinkedIn conversation reading is not implemented yet',
    chatUrl: entryUrl,
    messages: []
  };
}

export async function sendMessage(entryUrl, message) {
  const cdp = await createTab({ url: entryUrl });
  try {
    await cdp.navigate(entryUrl);
    const result = await cdp.evalJs(`(async () => {
      ${pageScript}
      const text = ${JSON.stringify(message)};
      const bodyText = textOf(document.body);
      if (/(captcha|security check|verify|verification|sign in|join now|unusual activity|challenge|login)/i.test(bodyText)) {
        return { ok: false, needHuman: true, reason: 'LinkedIn login or verification required', chatUrl: location.href };
      }
      const opener = await openMessageDialog();
      if (!opener.ok) return { ok: false, needHuman: true, reason: opener.reason, chatUrl: location.href };
      const dialog = opener.dialog;
      const editor = findEditor(dialog);
      if (!editor) return { ok: false, needHuman: true, reason: 'LinkedIn message editor not found', chatUrl: location.href };
      editor.focus();
      if (editor.tagName === 'TEXTAREA') {
        editor.value = text;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }));
      } else {
        editor.innerHTML = '';
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, text); } catch {}
        if (!inserted) {
          editor.textContent = text;
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }));
        }
      }
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(900);
      const currentText = (editor.innerText || editor.value || '').trim();
      if (!currentText || !currentText.includes(text.slice(0, Math.min(12, text.length)))) {
        return { ok: false, needHuman: true, reason: 'LinkedIn editor content check failed', chatUrl: location.href };
      }
      const sendButton = findSendButton(dialog);
      if (!sendButton) return { ok: false, needHuman: true, reason: 'LinkedIn Send button not found or disabled', chatUrl: location.href };
      clickEl(sendButton);
      await sleep(1600);
      const afterText = (editor.innerText || editor.value || '').trim();
      if (afterText && afterText.includes(text.slice(0, Math.min(12, text.length)))) {
        return { ok: false, needHuman: true, reason: 'LinkedIn message remains in editor after clicking Send', chatUrl: location.href };
      }
      return { ok: true, needHuman: false, reason: 'LinkedIn message sent', chatUrl: location.href };
    })()`);
    return result;
  } finally {
    cdp.close();
  }
}
