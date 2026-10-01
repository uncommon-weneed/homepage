export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 회원가입 API (아이디 중복 검사 추가)
    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { username, password, fullName } = await request.json();
        
        // 중복 아이디 검사
        const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(username).first();
        if (existing) {
          return new Response(JSON.stringify({ error: "이미 사용 중인 아이디입니다. 다른 아이디를 입력해주세요." }), { status: 400 });
        }

        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        await env.DB.prepare(
          "INSERT INTO users (username, password, full_name, status) VALUES (?, ?, ?, 'pending')"
        ).bind(username, hashedPassword, fullName).run();

        return Response.json({ success: true });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message || "오류가 발생했습니다." }), { status: 500 });
      }
    }

    // 2. 로그인 API (관리자 admin / admin)
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const { username, password } = await request.json();

        if (username === "admin" && password === "admin") {
          return Response.json({ success: true, username: "admin", fullName: "총괄관리자", isAdmin: true, status: "approved" });
        }

        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(username, hashedPassword).first();
        if (!user) return new Response(JSON.stringify({ error: "아이디 또는 비밀번호가 일치하지 않습니다." }), { status: 401 });
        if (user.status !== "approved") return new Response(JSON.stringify({ error: "교역자 승인 대기 중입니다." }), { status: 403 });

        return Response.json({ success: true, id: user.id, username: user.username, fullName: user.full_name, isAdmin: false, status: user.status });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 3. 관리자 회원 관리 (목록, 승인, 삭제, 비밀번호 초기화)
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, username, full_name, status FROM users ORDER BY id DESC").all();
      return Response.json(results || []);
    }
    if (url.pathname === "/api/admin/action" && request.method === "POST") {
      const { id, action } = await request.json();
      if (action === "approve") await env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(id).run();
      else if (action === "reject" || action === "delete") await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      else if (action === "reset_pw") {
        // 비밀번호를 '0000'으로 초기화
        const msgBuffer = new TextEncoder().encode("0000");
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashed0000 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
        await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(hashed0000, id).run();
      }
      return Response.json({ success: true });
    }

    // 4. 관리자 게시글 강제 삭제 연동
    if (url.pathname === "/api/admin/posts/delete" && request.method === "POST") {
      const { id } = await request.json();
      const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
      if (post && post.image_url) {
        try { await env.BUCKET.delete(post.image_url.replace("/api/images/", "")); } catch (err) {}
      }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // 5. 일반 게시글 조회, 등록, 수정, 삭제 (기존 동일)
    if (url.pathname === "/api/posts" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
      return Response.json(results || []);
    }
    if (url.pathname === "/api/posts" && request.method === "POST") {
      const formData = await request.formData();
      const author = formData.get("author") || "익명"; const username = formData.get("username") || "";
      const title = formData.get("title") || "제목 없음"; const category = formData.get("category") || "일반나눔";
      const content = formData.get("content") || ""; const image = formData.get("image");
      let imageUrl = "";
      if (image && typeof image === "object" && image.size > 0 && image.name) {
        const ext = image.name.split(".").pop(); const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type || "image/jpeg" } });
        imageUrl = `/api/images/${fileName}`;
      }
      await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)").bind(`${author}|${username}|${title}|${category}`, content, imageUrl).run();
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/api/posts" && request.method === "PUT") {
      const formData = await request.formData();
      const id = formData.get("id"); const content = formData.get("content") || ""; const title = formData.get("title") || "제목 없음";
      const authorMeta = formData.get("authorMeta"); const keepImage = formData.get("keepImage") || ""; const image = formData.get("image");
      let imageUrl = keepImage;
      if (image && typeof image === "object" && image.size > 0 && image.name) {
        const ext = image.name.split(".").pop(); const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type || "image/jpeg" } });
        imageUrl = `/api/images/${fileName}`;
      }
      await env.DB.prepare("UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?").bind(`${authorMeta}|${title}`, content, imageUrl, id).run();
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      const { id } = await request.json();
      const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
      if (post && post.image_url) { try { await env.BUCKET.delete(post.image_url.replace("/api/images/", "")); } catch (err) {} }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // 6. R2 버킷 이미지 서빙
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const imageName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(imageName);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    return env.ASSETS.fetch(request);
  }
};