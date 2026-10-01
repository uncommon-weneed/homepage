export async function onRequestPost(context) {
  try {
    const { username, password } = await context.request.json();
    if (!username || !password) return new Response(JSON.stringify({ error: "정보 부족" }), { status: 400 });

    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    await context.env.DB.prepare("INSERT INTO users (username, password) VALUES (?, ?)").bind(username, hashedPassword).run();
    return Response.json({ success: true });
  } catch (e) {
    return new Response(JSON.stringify({ error: "중복된 아이디이거나 오류 발생" }), { status: 400 });
  }
}
