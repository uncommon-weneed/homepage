export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 회원가입 API
    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { username, password } = await request.json();
        if (!username || !password) {
          return new Response(JSON.stringify({ error: "아이디와 비밀번호를 모두 입력하세요." }), { status: 400 });
        }

        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        await env.DB.prepare("INSERT INTO users (username, password) VALUES (?, ?)")
          .bind(username, hashedPassword)
          .run();

        return Response.json({ success: true });
      } catch (e) {
        return new Response(JSON.stringify({ error: "이미 존재하는 아이디이거나 오류가 발생했습니다." }), { status: 400 });
      }
    }

    // 2. 로그인 API
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await request.json();
      const msgBuffer = new TextEncoder().encode(password);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?")
        .bind(username, hashedPassword)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "아이디 또는 비밀번호가 일치하지 않습니다." }), { status: 401 });
      }

      return Response.json({ success: true, username: user.username });
    }

    // 3. 게시판 목록 불러오기
    if (url.pathname === "/api/posts" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC").all();
        return Response.json(results || []);
      } catch (e) {
        return new Response(JSON.stringify({ error: "게시글을 불러올 수 없습니다." }), { status: 500 });
      }
    }

    // 4. 새 게시글 작성 및 이미지 업로드
    if (url.pathname === "/api/posts" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const author = formData.get("author") || "익명";
        const content = formData.get("content");
        const image = formData.get("image");

        let imageUrl = "";
        if (image && image.name && image.size > 0) {
          const ext = image.name.split('.').pop();
          const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
          await env.BUCKET.put(fileName, image.stream(), {
            httpMetadata: { contentType: image.type }
          });
          imageUrl = `/api/images/${fileName}`;
        }

        await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)")
          .bind(author, content, imageUrl)
          .run();

        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(JSON.stringify({ error: "게시글 저장에 실패했습니다." }), { status: 500 });
      }
    }

    // 5. R2에 저장된 이미지 서빙
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const imageName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(imageName);
      if (!object) return new Response("Not found", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    // 6. 그 외 요청(웹사이트 접속 등)은 정적 애셋(index.html)으로 서빙
    return env.ASSETS.fetch(request);
  }
};
