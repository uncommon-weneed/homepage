export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 회원가입 API (pending 상태로 저장)
    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { username, password, fullName } = await request.json();
        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        await env.DB.prepare(
          "INSERT INTO users (username, password, full_name, status) VALUES (?, ?, ?, 'pending')"
        ).bind(username, hashedPassword, fullName).run();

        return Response.json({ success: true });
      } catch (e) {
        return new Response(JSON.stringify({ error: "아이디 중복 또는 오류" }), { status: 400 });
      }
    }

    // 2. 로그인 API (관리자 하드코딩 + 승인 확인)
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await request.json();

      // 관리자 계정
      if (username === "admin" && password === "grace1234!") {
        return Response.json({ success: true, username: "admin", fullName: "관리자", isAdmin: true, status: "approved" });
      }

      const msgBuffer = new TextEncoder().encode(password);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(username, hashedPassword).first();
      if (!user) return new Response(JSON.stringify({ error: "정보 불일치" }), { status: 401 });
      if (user.status !== "approved") return new Response(JSON.stringify({ error: "관리자 승인 대기중입니다." }), { status: 403 });

      return Response.json({ success: true, username: user.username, fullName: user.full_name, isAdmin: false, status: user.status });
    }

    // 3. 관리자 회원 목록 & 승인
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY id DESC").all();
      return Response.json(results || []);
    }
    if (url.pathname === "/api/admin/action" && request.method === "POST") {
      const { id, action } = await request.json();
      if (action === "approve") await env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(id).run();
      else await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // 4. 게시글 작성 & R2 업로드
    if (url.pathname === "/api/posts" && request.method === "POST") {
      const formData = await request.formData();
      const author = formData.get("author") || "익명";
      const content = formData.get("content");
      const image = formData.get("image");

      let imageUrl = "";
      if (image && image.name) {
        const ext = image.name.split(".").pop();
        const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type } });
        imageUrl = `/api/images/${fileName}`;
      }
      await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)").bind(author, content, imageUrl).run();
      return new Response("OK", { status: 200 });
    }

    // 5. 게시글 조회
    if (url.pathname === "/api/posts" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
      return Response.json(results || []);
    }

    // 6. R2 이미지 서빙
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const imageName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(imageName);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }

    // 7. 정적 파일(index.html 등) 서빙
    return env.ASSETS.fetch(request);
  }
};
