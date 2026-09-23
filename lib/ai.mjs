export async function generateSuggestion({ profile, messages, style }) {
  const platform = profile.platform === 'linkedin' ? 'linkedin' : 'xiaohongshu';
  const platformText = platform === 'linkedin' ? 'LinkedIn' : '小红书';
  const context = messages
    .slice(-12)
    .map(message => `${message.role}: ${message.content}`)
    .join('\n');

  if (process.env.AI_API_URL) {
    const response = await fetch(process.env.AI_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.AI_API_KEY ? { authorization: `Bearer ${process.env.AI_API_KEY}` } : {})
      },
      body: JSON.stringify({
        platform,
        profile,
        style,
        messages,
        instruction: `生成一条可发送给${platformText}用户的建联回复，返回 JSON：{"reply":"","reason":"","risk":"low|medium|high"}`
      })
    });
    if (!response.ok) {
      throw new Error(`AI 接口失败：${response.status}`);
    }
    const data = await response.json();
    return {
      reply: data.reply || data.content || '',
      reason: data.reason || '由外部 AI 接口生成',
      risk: data.risk || 'low'
    };
  }

  const name = profile.display_name || '';
  const hasHistory = context.trim().length > 0;
  const greeting = name ? `${name}，您好。` : '您好。';
  const reply = hasHistory
    ? `${greeting}谢谢回复。我是${style.identity}，主要想基于您公开主页里的经历做一次简短交流。如果方便，我想了解下您近期关注的方向，看看是否有合适的合作或沟通机会。`
    : `${greeting}我是${style.identity}，看到您的${platformText}主页后对您的经历挺感兴趣，想简单认识一下，看看后续是否有合作或交流的可能。方便的话可以聊两句。`;
  return {
    reply,
    reason: '未配置 AI_API_URL，使用本地风格模板生成',
    risk: 'low'
  };
}
