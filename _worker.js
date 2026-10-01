export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 회원가입 API
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
        return new Response(JSON.stringify({ error: "아이디 중복 또는 등록 실패" }), { status: 400 });
      }
    }

    // 2. 로그인 API
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await request.json();

      if (username === "admin" && password === "admin") {
        return Response.json({ success: true, username: "admin", fullName: "관리자", isAdmin: true, status: "approved" });
      }

      const msgBuffer = new TextEncoder().encode(password);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(username, hashedPassword).first();
      if (!user) return new Response(JSON.stringify({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }), { status: 401 });
      if (user.status !== "approved") return new Response(JSON.stringify({ error: "교역자 승인 대기 중입니다." }), { status: 403 });

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

    // 4. 게시글 조회 (GET)
    if (url.pathname === "/api/posts" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
      return Response.json(results || []);
    }

    // 5. 게시글 등록 (POST)
    if (url.pathname === "/api/posts" && request.method === "POST") {
      const formData = await request.formData();
      const author = formData.get("author") || "익명";
      const username = formData.get("username") || "";
      const title = formData.get("title") || "제목 없음";
      const content = formData.get("content");
      const category = formData.get("category") || "일반";
      const image = formData.get("image");

      let imageUrl = "";
      if (image && image.name && image.size > 0) {
        const ext = image.name.split(".").pop();
        const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type } });
        imageUrl = `/api/images/${fileName}`;
      }

      await env.DB.prepare(
        "INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)"
      ).bind(`${author}|${username}|${title}|${category}`, content, imageUrl).run();
      
      return new Response("OK", { status: 200 });
    }

    // 6. 게시글 수정 (PUT)
    if (url.pathname === "/api/posts" && request.method === "PUT") {
      const formData = await request.formData();
      const id = formData.get("id");
      const content = formData.get("content");
      const title = formData.get("title") || "제목 없음";
      const authorMeta = formData.get("authorMeta");
      const keepImage = formData.get("keepImage");
      const image = formData.get("image");

      let imageUrl = keepImage;
      if (image && image.name && image.size > 0) {
        const ext = image.name.split(".").pop();
        const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type } });
        imageUrl = `/api/images/${fileName}`;
      }

      await env.DB.prepare(
        "UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?"
      ).bind(`${authorMeta}|${title}`, content, imageUrl, id).run();

      return new Response("OK", { status: 200 });
    }

    // 7. 게시글 삭제 (DELETE)
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      const { id } = await request.json();
      const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
      
      if (post && post.image_url) {
        const imageName = post.image_url.replace("/api/images/", "");
        try { await env.BUCKET.delete(imageName); } catch (e) {}
      }

      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // 8. R2 이미지 서빙
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const imageName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(imageName);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }

    // 9. 정적 파일 서빙
    return env.ASSETS.fetch(request);
  }
};