export async function onRequestPost(context) {
  const { username, password } = await context.request.json();
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  const user = await context.env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(username, hashedPassword).first();
  if (!user) return new Response(JSON.stringify({ error: "로그인 정보 불일치" }), { status: 401 });

  return Response.json({ success: true, username: user.username });
}
