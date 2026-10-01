export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 회원가입 API (관리자 승인 대기 상태 'pending'으로 등록)
    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { username, password, fullName, role, parish, phone } = await request.json();
        if (!username || !password || !fullName) {
          return new Response(JSON.stringify({ error: "필수 입력 항목(아이디, 비밀번호, 성명)을 입력하세요." }), { status: 400 });
        }

        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        await env.DB.prepare(
          "INSERT INTO users (username, password, full_name, role, parish, phone, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
        ).bind(username, hashedPassword, fullName, role || "성도", parish || "미배정", phone || "").run();

        return Response.json({ success: true });
      } catch (e) {
        return new Response(JSON.stringify({ error: "이미 존재하는 아이디이거나 데이터 처리 오류입니다." }), { status: 400 });
      }
    }

    // 2. 로그인 API
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await request.json();

      // 마스터 관리자 임의 지정 계정 (DB 등록 없이 즉시 통과)
      if (username === "church_admin" && password === "grace2026!") {
        return Response.json({
          success: true,
          username: "church_admin",
          fullName: "총괄관리자",
          role: "교역자",
          isAdmin: true,
          status: "approved"
        });
      }

      // 일반 성도 계정 조회
      const msgBuffer = new TextEncoder().encode(password);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?")
        .bind(username, hashedPassword)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "아이디 또는 비밀번호가 일치하지 않습니다." }), { status: 401 });
      }

      if (user.status !== "approved") {
        return new Response(JSON.stringify({ error: "현재 교역자 승인 대기 상태입니다. 승인 완료 후 이용 가능합니다." }), { status: 403 });
      }

      return Response.json({
        success: true,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        isAdmin: false,
        status: user.status
      });
    }

    // 3. 관리자 전용: 회원 목록 조회
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT id, username, full_name, role, parish, phone, status, requested_at FROM users ORDER BY id DESC").all();
        return Response.json(results || []);
      } catch (e) {
        return new Response(JSON.stringify({ error: "회원 목록 조회 실패" }), { status: 500 });
      }
    }

    // 4. 관리자 전용: 회원 승인 / 반려 제어
    if (url.pathname === "/api/admin/action" && request.method === "POST") {
      try {
        const { id, action } = await request.json();
        if (action === "approve") {
          await env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(id).run();
        } else if (action === "reject") {
          await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        }
        return Response.json({ success: true });
      } catch (e) {
        return new Response(JSON.stringify({ error: "처리 중 오류 발생" }), { status: 500 });
      }
    }

    // 5. 게시글 목록 불러오기
    if (url.pathname === "/api/posts" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
        return Response.json(results || []);
      } catch (e) {
        return new Response(JSON.stringify({ error: "게시글 조회 실패" }), { status: 500 });
      }
    }

    // 6. 게시글 작성 및 R2 사진 업로드
    if (url.pathname === "/api/posts" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const author = formData.get("author") || "익명";
        const role = formData.get("role") || "성도";
        const title = formData.get("title") || "제목 없음";
        const category = formData.get("category") || "공지사항";
        const content = formData.get("content");
        const image = formData.get("image");

        let imageUrl = "";
        if (image && image.name && image.size > 0) {
          const ext = image.name.split(".").pop();
          const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
          await env.BUCKET.put(fileName, image.stream(), {
            httpMetadata: { contentType: image.type }
          });
          imageUrl = `/api/images/${fileName}`;
        }

        await env.DB.prepare(
          "INSERT INTO posts (author, role, title, category, content, image_url) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(author, role, title, category, content, imageUrl).run();

        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(JSON.stringify({ error: "게시글 작성 실패" }), { status: 500 });
      }
    }

    // 7. R2 버킷에 저장된 사진 서빙
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const imageName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(imageName);
      if (!object) return new Response("Not found", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    // 8. 기타 요청은 정적 웹사이트 애셋(index.html) 서빙
    return env.ASSETS.fetch(request);
  }
};