import { createTab } from './cdp.mjs';

const NEED_HUMAN_RE = /(\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u6ed1\u5757|\u767b\u5f55|\u626b\u7801|\u98ce\u9669|\u5f02\u5e38\u8bbf\u95ee|\u8bf7\u5148\u767b\u5f55|\u9a8c\u8bc1)/i;

const pageScript = `
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fire = (el, type) => el && el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  const textOf = el => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const descriptorOf = el => [
    textOf(el),
    el && el.getAttribute && (el.getAttribute('aria-label') || ''),
    el && el.getAttribute && (el.getAttribute('title') || ''),
    el && el.getAttribute && (el.getAttribute('data-tooltip') || ''),
    el && el.getAttribute && (el.getAttribute('data-v-tooltip') || ''),
    el && el.className || '',
    el && el.id || ''
  ].join(' ');
  const hover = async el => {
    fire(el, 'mouseover');
    fire(el, 'mouseenter');
    try { el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' })); } catch {}
    await sleep(350);
  };
  const messageRe = /(\\u53d1\\u6d88\\u606f|\\u53d1\\u79c1\\u4fe1|\\u79c1\\u4fe1|\\u6d88\\u606f|\\u8054\\u7cfb|\\u804a\\u5929)/;
  const moreRe = /(\\u66f4\\u591a|more|\\.\\.\\.|···)/i;
  const looksLikeMessageEntry = text => messageRe.test(text || '');
  const looksLikeMore = el => moreRe.test(descriptorOf(el)) || textOf(el) === '...';
  const findMessageButton = async () => {
    const direct = [...document.querySelectorAll('button, div, span, a')]
      .find(el => looksLikeMessageEntry(descriptorOf(el)) && !looksLikeMore(el) && textOf(el).length <= 20);
    if (direct) return direct.closest('button,a,[role="button"]') || direct;
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="icon"], svg')]
      .map(el => el.closest('button,a,[role="button"],div,span') || el)
      .filter((el, index, arr) => el && arr.indexOf(el) === index)
      .slice(0, 160);
    for (const el of candidates) {
      if (looksLikeMore(el)) continue;
      const before = textOf(document.body);
      await hover(el);
      const after = textOf(document.body);
      const added = after.replace(before, '');
      if (/\\u53d1\\u6d88\\u606f|\\u53d1\\u79c1\\u4fe1/.test(added) || (/\\u53d1\\u6d88\\u606f|\\u53d1\\u79c1\\u4fe1/.test(after) && after !== before)) {
        return el.closest('button,a,[role="button"]') || el;
      }
    }
    return null;
  };
  const findEditor = () => {
    const all = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('[class*="input"] [contenteditable="true"]'),
      ...document.querySelectorAll('[class*="editor"] [contenteditable="true"]')
    ];
    return all.find(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 80 && rect.height > 18 && style.visibility !== 'hidden' && style.display !== 'none';
    }) || null;
  };
  const waitForEditor = async () => {
    for (let i = 0; i < 20; i++) {
      const editor = findEditor();
      if (editor) return editor;
      await sleep(500);
    }
    return null;
  };
  const clickMessageEntryIfNeeded = async () => {
    if (location.href.includes('/chat')) return { clicked: false, chatUrl: location.href };
    const button = await findMessageButton();
    if (!button) return { clicked: false, chatUrl: '', reason: 'message entry not found' };
    fire(button, 'mousedown'); fire(button, 'mouseup'); fire(button, 'click');
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (location.href.includes('/chat')) return { clicked: true, chatUrl: location.href };
      if (findEditor()) return { clicked: true, chatUrl: location.href };
    }
    return { clicked: true, chatUrl: location.href, reason: 'clicked but chat did not become ready' };
  };
`;

function hasNeedHuman(snapshot) {
  return NEED_HUMAN_RE.test(`${snapshot.title || ''} ${snapshot.text || ''}`);
}

export async function openAndReadProfile(profileUrl) {
  const cdp = await createTab({ url: profileUrl });
  try {
    await cdp.navigate(profileUrl);
    const snapshot = await cdp.evalJs(`(async () => {
      ${pageScript}
      const text = textOf(document.body);
      const title = document.title || '';
      const name = (
        document.querySelector('.user-name') ||
        document.querySelector('[class*="user-name"]') ||
        document.querySelector('[class*="nickname"]') ||
        document.querySelector('h1')
      )?.textContent?.trim() || '';
      const entry = await clickMessageEntryIfNeeded();
      return { url: location.href, chatUrl: entry.chatUrl || '', entry, title, name, text: text.slice(0, 3000) };
    })()`);
    return {
      ok: true,
      needHuman: hasNeedHuman(snapshot),
      displayName: snapshot.name || snapshot.title.replace(/ - .*/, ''),
      chatUrl: snapshot.chatUrl && snapshot.chatUrl.includes('/chat') ? snapshot.chatUrl : '',
      snapshot
    };
  } finally {
    cdp.close();
  }
}

export async function readConversation(entryUrl) {
  const cdp = await createTab({ url: entryUrl });
  try {
    await cdp.navigate(entryUrl);
    const result = await cdp.evalJs(`(async () => {
      ${pageScript}
      const bodyText = textOf(document.body);
      if (/(\\u9a8c\\u8bc1\\u7801|\\u5b89\\u5168\\u9a8c\\u8bc1|\\u6ed1\\u5757|\\u8bf7\\u5148\\u767b\\u5f55|\\u626b\\u7801|\\u767b\\u5f55\\u540e)/.test(bodyText)) {
        return { ok: false, needHuman: true, reason: 'login or verification required', messages: [], chatUrl: location.href };
      }
      const entry = await clickMessageEntryIfNeeded();
      const editor = await waitForEditor();
      if (!editor) {
        return { ok: false, needHuman: true, reason: entry.clicked ? 'clicked message entry but editor not found' : 'chat editor not found', messages: [], chatUrl: location.href };
      }
      const editorRect = editor.getBoundingClientRect();
      const paneLeft = Math.max(0, editorRect.left - 40);
      const paneRight = Math.min(window.innerWidth, editorRect.right + 40);
      const paneMid = paneLeft + ((paneRight - paneLeft) / 2);
      const minTop = Math.max(90, window.innerHeight * 0.10);
      const maxBottom = Math.max(minTop, editorRect.top - 16);
      const isVisible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const isInsideRightChatPane = el => {
        const rect = el.getBoundingClientRect();
        return (
          rect.left >= paneLeft &&
          rect.right <= paneRight &&
          rect.top >= minTop &&
          rect.bottom <= maxBottom
        );
      };
      const isLeafMessageText = el => {
        const text = textOf(el);
        if (!text || text.length < 1 || text.length > 500) return false;
        if (/(\\u53d1\\u6d88\\u606f|\\u641c\\u7d22|\\u9996\\u9875|RED|\\u76f4\\u64ad|\\u901a\\u77e5|\\u66f4\\u591a|\\u5173\\u4e8e\\u6211\\u4eec)/.test(text)) return false;
        if (/\\u5bf9\\u65b9\\u5173\\u6ce8\\u6216\\u56de\\u590d\\u4f60\\u4e4b\\u524d/.test(text)) return false;
        const childSameText = [...el.children].some(child => textOf(child) === text);
        if (childSameText) return false;
        const rect = el.getBoundingClientRect();
        if (rect.height > 180) return false;
        return true;
      };
      const preferred = [
        ...document.querySelectorAll('[class*="bubble"], [class*="msg"], [class*="message"], [class*="content"]')
      ].filter(el => isVisible(el) && isInsideRightChatPane(el) && isLeafMessageText(el));
      const fallback = preferred.length ? [] : [
        ...document.querySelectorAll('div, p, span')
      ].filter(el => isVisible(el) && isInsideRightChatPane(el) && isLeafMessageText(el));
      const nodes = [...preferred, ...fallback]
        .map(el => {
          const rect = el.getBoundingClientRect();
          return {
            top: rect.top,
            left: rect.left,
            role: rect.left > paneMid ? 'self' : 'target',
            content: textOf(el)
          };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const seen = new Set();
      const unique = [];
      for (const item of nodes) {
        const key = item.role + ':' + item.content;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(item);
        }
      }
      return {
        ok: true,
        needHuman: false,
        reason: entry.clicked ? 'opened chat from profile and read right chat pane' : 'read right chat pane',
        chatUrl: location.href.includes('/chat') ? location.href : (entry.chatUrl || ''),
        messages: unique.slice(-40).map(item => ({ role: item.role === 'self' ? 'self' : 'target', content: item.content }))
      };
    })()`);
    return result;
  } finally {
    cdp.close();
  }
}

export async function sendMessage(entryUrl, message) {
  const cdp = await createTab({ url: entryUrl });
  try {
    await cdp.navigate(entryUrl);
    const prepared = await cdp.evalJs(`(async () => {
      ${pageScript}
      const text = ${JSON.stringify(message)};
      const bodyText = textOf(document.body);
      if (/(\\u9a8c\\u8bc1\\u7801|\\u5b89\\u5168\\u9a8c\\u8bc1|\\u6ed1\\u5757|\\u8bf7\\u5148\\u767b\\u5f55|\\u626b\\u7801|\\u767b\\u5f55\\u540e)/.test(bodyText)) {
        return { ok: false, needHuman: true, reason: 'login or verification required', chatUrl: location.href };
      }
      const entry = await clickMessageEntryIfNeeded();
      const editor = await waitForEditor();
      if (!editor) {
        return { ok: false, needHuman: true, reason: entry.clicked ? 'clicked message entry but editor not found' : 'message entry/editor not found', chatUrl: location.href };
      }
      editor.focus();
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
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
      await sleep(700);
      const currentText = (editor.innerText || editor.value || '').trim();
      if (!currentText || !currentText.includes(text.slice(0, Math.min(12, text.length)))) {
        return { ok: false, needHuman: true, reason: 'editor content check failed', chatUrl: location.href };
      }
      window.__digclawLastSendText = text;
      window.__digclawBodyBeforeSend = textOf(document.body);
      return { ok: true, needHuman: false, reason: 'editor filled, ready to send by Enter', chatUrl: location.href };
    })()`);
    if (!prepared.ok) return prepared;

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      unmodifiedText: '\r',
      text: '\r'
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });

    const result = await cdp.evalJs(`(async () => {
      ${pageScript}
      await sleep(1800);
      const editor = findEditor();
      const editorText = editor ? (editor.innerText || editor.value || '').trim() : '';
      const bodyAfter = textOf(document.body);
      const sentText = window.__digclawLastSendText || '';
      const bodyBefore = window.__digclawBodyBeforeSend || '';
      if (!editorText || !editorText.includes(sentText.slice(0, Math.min(12, sentText.length))) || bodyAfter !== bodyBefore) {
        return { ok: true, needHuman: false, reason: 'sent by Enter', chatUrl: location.href };
      }
      return { ok: false, needHuman: true, reason: 'Enter did not trigger send, message remains in editor', chatUrl: location.href };
    })()`);
    return result;
  } finally {
    cdp.close();
  }
}
