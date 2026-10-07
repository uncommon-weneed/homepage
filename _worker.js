/**
 * Our Secret Space - Cloudflare Workers Backend API
 * 
 * 기능 모듈:
 * 1. [설정 API] /api/settings (GET, POST)
 * 2. [파일 업로드 API] /api/admin/site-image (POST) - R2 미디어 바인딩
 * 3. [인증 API] /api/login (POST) - 비밀번호 0709
 * 4. [게시글 & 캘린더 다이어리 API] /api/posts (GET, POST, PUT, DELETE)
 * 5. [댓글 API] /api/comments (GET, POST, DELETE)
 * 6. [커플 Q&A 및 추가 질문 API] /api/questions (GET, POST, PUT, DELETE)
 * 7. [네이버 지도 연동 데이트 장소 API] /api/places (GET, POST, PUT, DELETE)
 * 8. [하루 일정 계획 & 챙길 물품 메모 API] /api/planner (GET, POST, PUT, DELETE)
 * 9. [사랑의 커플 쿠폰북 API] /api/coupons (GET, POST, PUT, DELETE)
 * 10. [R2 버킷 미디어 서빙] /api/images/* (GET)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // OPTIONS 사전 요청(CORS) 지원
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // 공통 캐시 방지 JSON 응답 헬퍼
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
          "Access-Control-Allow-Origin": "*"
        }
      });
    };

    // 헬퍼: site_settings 기반 JSON 스토리지 안전 읽기
    const getSettingJson = async (key, defaultVal = []) => {
      try {
        const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = ?").bind(key).first();
        if (row && row.value) {
          return JSON.parse(row.value);
        }
      } catch (e) {}
      return defaultVal;
    };

    // 헬퍼: site_settings 기반 JSON 스토리지 안전 저장
    const saveSettingJson = async (key, data) => {
      try {
        const jsonStr = JSON.stringify(data);
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
          .bind(key, jsonStr, jsonStr).run();
        return true;
      } catch (e) {
        return false;
      }
    };

    // 1. [설정 API] D-Day, 이름, 타임라인, 휴일 등 공통 설정 관리
    if (url.pathname === "/api/settings" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
        const settings = {};
        (results || []).forEach(r => { settings[r.key] = r.value; });
        return jsonResponse(settings);
      } catch (e) { 
        return jsonResponse({}); 
      }
    }
    
    if (url.pathname === "/api/settings" && request.method === "POST") {
      try {
        const { key, value } = await request.json();
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
            .bind(key, value, value).run();
        return jsonResponse({ success: true });
      } catch (e) { 
        return jsonResponse({ error: e.message }, 500); 
      }
    }

    // 2. [파일 업로드 API] 배경, 프로필 등 관리자 전용 사진 교체
    if (url.pathname === "/api/admin/site-image" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const key = formData.get("key"); 
        const file = formData.get("image");
        if (!key || !file || file.size === 0) return jsonResponse({ error: "No file provided" }, 400);
        
        const ext = file.name.split(".").pop(); 
        const fileName = `site-${key}-${Date.now()}.${ext}`;
        await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
        
        const fileUrl = `/api/images/${fileName}`;
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
            .bind(key, fileUrl, fileUrl).run();
        
        return jsonResponse({ success: true, imageUrl: fileUrl });
      } catch (e) { 
        return jsonResponse({ error: e.message }, 500); 
      }
    }

    // 3. [인증 API] 커플 전용 비밀번호 인증 (0709)
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const inputPw = String(reqData.password || reqData.pw || "").trim();
        
        // 비밀번호 0709 확인 (아이디 유무 무관, 공백 제거 후 비교)
        if (inputPw === "0709") {
          return jsonResponse({ 
              success: true, 
              username: "ourlove", 
              fullName: "우리", // '우리'로 설정해야 index.html에서 작성자 선택 팝업(히니/효니)이 뜹니다.
              isAdmin: true, 
              status: "approved" 
          });
        }
        return jsonResponse({ error: "비밀번호가 올바르지 않습니다. 다시 입력해 주세요." }, 401);
      } catch (e) { 
        return jsonResponse({ error: e.message }, 500); 
      }
    }

    // 4. [게시글 & 캘린더 다이어리 API]
    if (url.pathname === "/api/posts" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
        return jsonResponse(results || []);
      } catch (e) {
        return jsonResponse([]);
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "POST") {
      try {
          const formData = await request.formData();
          const author = formData.get("author") || "익명"; 
          const username = formData.get("username") || "ourlove";
          const title = formData.get("title") || "무제"; 
          const category = formData.get("category") || "데이트록";
          const dateStr = formData.get("date") || ""; 
          const exactTime = formData.get("exactTime") || ""; // 일정 컬러
          const createdAt = formData.get("createdAt") || new Date().toISOString(); // 실제 작성 시간
          const content = formData.get("content") || ""; 
          
          // [다중 사진 첨부 완벽 지원]: formData.getAll로 'images' 및 'image' 모두 수집
          const rawFiles = [...formData.getAll("images"), ...formData.getAll("image")];
          const validFiles = rawFiles.filter(f => f && typeof f === "object" && f.size > 0 && f.name);
          
          const fileUrls = [];
          for (const file of validFiles) {
            const ext = file.name.split(".").pop(); 
            const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
            fileUrls.push(`/api/images/${fileName}`);
          }
          
          // 1장이면 단일 문자열, 여러 장이면 JSON 배열 문자열로 보관 (기존 글 완벽 하위 호환)
          let finalImageUrl = "";
          if (fileUrls.length === 1) {
            finalImageUrl = fileUrls[0];
          } else if (fileUrls.length > 1) {
            finalImageUrl = JSON.stringify(fileUrls);
          }
          
          // 저장 포맷: 이름(0)|아이디(1)|제목(2)|카테고리(3)|캘린더날짜(4)|일정색상(5)|작성일시(6)
          const authorMeta = `${author}|${username}|${title}|${category}|${dateStr}|${exactTime}|${createdAt}`;
          await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)")
              .bind(authorMeta, content, finalImageUrl).run();
              
          return jsonResponse({ success: true, imageUrl: finalImageUrl }, 200);
      } catch (e) {
          return jsonResponse({ error: e.message }, 500); 
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "PUT") {
      try {
          const formData = await request.formData();
          const id = formData.get("id"); 
          const title = formData.get("title") || "무제"; 
          const category = formData.get("category") || "데이트록";
          const content = formData.get("content") || ""; 
          const dateStr = formData.get("date") || ""; 
          const exactTime = formData.get("exactTime") || ""; 
          const createdAt = formData.get("createdAt") || new Date().toISOString(); 
          const authorMeta = formData.get("authorMeta"); 
          const keepImage = formData.get("keepImage") || ""; 
          
          // 새로 업로드된 다중 파일 수집
          const rawFiles = [...formData.getAll("images"), ...formData.getAll("image")];
          const validFiles = rawFiles.filter(f => f && typeof f === "object" && f.size > 0 && f.name);
          
          let finalImageUrl = keepImage;
          if (validFiles.length > 0) {
            const newUrls = [];
            for (const file of validFiles) {
              const ext = file.name.split(".").pop(); 
              const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
              await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
              newUrls.push(`/api/images/${fileName}`);
            }
            finalImageUrl = newUrls.length === 1 ? newUrls[0] : JSON.stringify(newUrls);
          }
          
          const newAuthorMeta = `${authorMeta}|${title}|${category}|${dateStr}|${exactTime}|${createdAt}`;
          await env.DB.prepare("UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?")
              .bind(newAuthorMeta, content, finalImageUrl, id).run();
              
          return jsonResponse({ success: true, imageUrl: finalImageUrl }, 200);
      } catch (e) {
          return jsonResponse({ error: e.message }, 500); 
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      try {
        const { id } = await request.json();
        const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
        if (post && post.image_url) { 
            const rawUrl = post.image_url.trim();
            if (rawUrl.startsWith('[') && rawUrl.endsWith(']')) {
              try {
                const arr = JSON.parse(rawUrl);
                for (const u of arr) {
                  try { await env.BUCKET.delete(String(u).replace("/api/images/", "")); } catch(delErr) {}
                }
              } catch(e) {}
            } else {
              try { await env.BUCKET.delete(rawUrl.replace("/api/images/", "")); } catch (err) {} 
            }
        }
        await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 5. [댓글 API] - D1 테이블 자동 복구 및 다중 스키마 완벽 Fallback
    if (url.pathname === "/api/comments" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM comments ORDER BY id ASC").all();
        return jsonResponse(results || []);
      } catch (e) {
        // comments 테이블이 없으면 자동 생성 시도
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS comments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              post_id INTEGER NOT NULL,
              author TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT
            )
          `).run();
        } catch(initErr) {}
        return jsonResponse([]);
      }
    }
    
    if (url.pathname === "/api/comments" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const pId = parseInt(reqData.postId || reqData.post_id || 0, 10);
        const author = String(reqData.author || "우리").trim();
        const username = String(reqData.username || (author === "효니" ? "hyoni" : (author === "히니" ? "hini" : "ourlove"))).trim();
        const content = String(reqData.content || "").trim();
        const commentTime = reqData.exactTime || reqData.created_at || new Date().toISOString();

        if (!pId) {
          return jsonResponse({ error: "게시글 번호(postId)가 유효하지 않습니다." }, 400);
        }
        if (!content) {
          return jsonResponse({ error: "댓글 내용을 입력해 주세요." }, 400);
        }

        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS comments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              post_id INTEGER NOT NULL,
              author TEXT NOT NULL,
              username TEXT NOT NULL DEFAULT 'ourlove',
              content TEXT NOT NULL,
              created_at TEXT
            )
          `).run();
        } catch(tblErr) {}

        try {
          await env.DB.prepare("INSERT INTO comments (post_id, author, username, content, created_at) VALUES (?, ?, ?, ?, ?)")
              .bind(pId, author, username, content, commentTime).run();
        } catch (colErr1) {
          try {
            await env.DB.prepare("INSERT INTO comments (post_id, author, username, content) VALUES (?, ?, ?, ?)")
                .bind(pId, author, username, `${content}__time:${commentTime}__`).run();
          } catch (colErr2) {
            try {
              await env.DB.prepare("INSERT INTO comments (post_id, author, content, created_at) VALUES (?, ?, ?, ?)")
                  .bind(pId, author, content, commentTime).run();
            } catch (colErr3) {
              await env.DB.prepare("INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)")
                  .bind(pId, author, `${content}__time:${commentTime}__`).run();
            }
          }
        }
        return jsonResponse({ success: true }, 200);
      } catch (e) {
        return jsonResponse({ error: `댓글 저장 오류: ${e.message}` }, 500);
      }
    }
    
    if (url.pathname === "/api/comments" && request.method === "DELETE") {
      try {
        const { id } = await request.json();
        await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 6. [커플 Q&A 및 추가 질문 API] - /api/questions
    // 사용자 요청: "추가 질문도 넣을 수 있게 해줘" 지원
    if (url.pathname === "/api/questions" && request.method === "GET") {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS couple_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            category TEXT DEFAULT '일상',
            created_by TEXT DEFAULT '우리',
            answer_hyoni TEXT DEFAULT '',
            answer_hini TEXT DEFAULT '',
            answered_at_hyoni TEXT DEFAULT '',
            answered_at_hini TEXT DEFAULT '',
            created_at TEXT
          )
        `).run();
        const { results } = await env.DB.prepare("SELECT * FROM couple_questions ORDER BY id ASC").all();
        if (results && results.length > 0) {
          return jsonResponse(results);
        }
        // D1에 데이터가 없으면 site_settings 백업 조회
        const fallbackList = await getSettingJson('couple_questions_json', []);
        return jsonResponse(fallbackList);
      } catch (e) {
        const fallbackList = await getSettingJson('couple_questions_json', []);
        return jsonResponse(fallbackList);
      }
    }

    if (url.pathname === "/api/questions" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const action = reqData.action || 'create';

        if (action === 'answer') {
          // 답변 등록 / 수정
          const qId = parseInt(reqData.id, 10);
          const author = String(reqData.author || '').trim(); // '효니' or '히니'
          const answer = String(reqData.answer || '').trim();
          const answerTime = new Date().toISOString();

          let success = false;
          try {
            if (author === '효니' || author.includes('효')) {
              await env.DB.prepare("UPDATE couple_questions SET answer_hyoni = ?, answered_at_hyoni = ? WHERE id = ?")
                .bind(answer, answerTime, qId).run();
            } else {
              await env.DB.prepare("UPDATE couple_questions SET answer_hini = ?, answered_at_hini = ? WHERE id = ?")
                .bind(answer, answerTime, qId).run();
            }
            success = true;
          } catch (dbErr) {}

          // site_settings 백업 동기화
          const list = await getSettingJson('couple_questions_json', []);
          const target = list.find(item => Number(item.id) === qId);
          if (target) {
            if (author === '효니' || author.includes('효')) {
              target.answer_hyoni = answer;
              target.answered_at_hyoni = answerTime;
            } else {
              target.answer_hini = answer;
              target.answered_at_hini = answerTime;
            }
            await saveSettingJson('couple_questions_json', list);
          }
          return jsonResponse({ success: true, action: 'answered' });
        }

        // 새 질문 추가 (사용자 커스텀 추가 질문 지원)
        const question = String(reqData.question || '').trim();
        const category = String(reqData.category || '일상').trim();
        const createdBy = String(reqData.createdBy || reqData.author || '우리').trim();
        const nowIso = new Date().toISOString();

        if (!question) {
          return jsonResponse({ error: "질문 내용을 입력해주세요." }, 400);
        }

        let newId = Date.now();
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS couple_questions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              question TEXT NOT NULL,
              category TEXT DEFAULT '일상',
              created_by TEXT DEFAULT '우리',
              answer_hyoni TEXT DEFAULT '',
              answer_hini TEXT DEFAULT '',
              answered_at_hyoni TEXT DEFAULT '',
              answered_at_hini TEXT DEFAULT '',
              created_at TEXT
            )
          `).run();

          const res = await env.DB.prepare("INSERT INTO couple_questions (question, category, created_by, created_at) VALUES (?, ?, ?, ?)")
            .bind(question, category, createdBy, nowIso).run();
          if (res && res.meta && res.meta.last_row_id) {
            newId = res.meta.last_row_id;
          }
        } catch (dbErr) {}

        // site_settings 백업 동기화
        const list = await getSettingJson('couple_questions_json', []);
        list.push({
          id: newId,
          question,
          category,
          created_by: createdBy,
          answer_hyoni: '',
          answer_hini: '',
          answered_at_hyoni: '',
          answered_at_hini: '',
          created_at: nowIso
        });
        await saveSettingJson('couple_questions_json', list);

        return jsonResponse({ success: true, id: newId, question }, 200);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/questions" && request.method === "PUT") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const qId = parseInt(reqData.id, 10);
        const question = String(reqData.question || '').trim();
        const category = String(reqData.category || '일상').trim();

        if (!qId || !question) return jsonResponse({ error: "유효한 질문 정보를 입력하세요." }, 400);

        try {
          await env.DB.prepare("UPDATE couple_questions SET question = ?, category = ? WHERE id = ?")
            .bind(question, category, qId).run();
        } catch (dbErr) {}

        const list = await getSettingJson('couple_questions_json', []);
        const target = list.find(item => Number(item.id) === qId);
        if (target) {
          target.question = question;
          target.category = category;
          await saveSettingJson('couple_questions_json', list);
        }
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/questions" && request.method === "DELETE") {
      try {
        const { id } = await request.json();
        const qId = parseInt(id, 10);
        try {
          await env.DB.prepare("DELETE FROM couple_questions WHERE id = ?").bind(qId).run();
        } catch (dbErr) {}

        const list = await getSettingJson('couple_questions_json', []);
        const filtered = list.filter(item => Number(item.id) !== qId);
        await saveSettingJson('couple_questions_json', filtered);

        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 7. [네이버 지도 연동 데이트 장소/위시리스트 API] - /api/places
    // 사용자 요청: "가고 싶은 장소나 하고 싶은 일에 이름을 내가 입력하기도 하지만 네이버 지도를 연동해서 가능하게 할 수 있을까?" 지원
    if (url.pathname === "/api/places" && request.method === "GET") {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS couple_places (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT DEFAULT '맛집',
            address TEXT DEFAULT '',
            naver_map_url TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            author TEXT DEFAULT '우리',
            visited INTEGER DEFAULT 0,
            rating INTEGER DEFAULT 5,
            created_at TEXT
          )
        `).run();
        const { results } = await env.DB.prepare("SELECT * FROM couple_places ORDER BY id DESC").all();
        if (results && results.length > 0) {
          return jsonResponse(results);
        }
        const fallback = await getSettingJson('couple_places_json', []);
        return jsonResponse(fallback);
      } catch (e) {
        const fallback = await getSettingJson('couple_places_json', []);
        return jsonResponse(fallback);
      }
    }

    if (url.pathname === "/api/places" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const name = String(reqData.name || '').trim();
        const category = String(reqData.category || '맛집').trim();
        const address = String(reqData.address || '').trim();
        // 네이버 지도 URL 자동 생성 헬퍼: 사용자가 URL을 주지 않아도 장소명 기반 네이버 검색 링크 자동 결합
        let naverMapUrl = String(reqData.naver_map_url || reqData.naverMapUrl || '').trim();
        if (!naverMapUrl && name) {
          naverMapUrl = `https://map.naver.com/p/search/${encodeURIComponent(name)}`;
        }
        const notes = String(reqData.notes || '').trim();
        const author = String(reqData.author || '우리').trim();
        const visited = reqData.visited ? 1 : 0;
        const rating = parseInt(reqData.rating || 5, 10);
        const nowIso = new Date().toISOString();

        if (!name) return jsonResponse({ error: "장소 또는 하고 싶은 일의 이름을 입력해주세요." }, 400);

        let newId = Date.now();
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS couple_places (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              category TEXT DEFAULT '맛집',
              address TEXT DEFAULT '',
              naver_map_url TEXT DEFAULT '',
              notes TEXT DEFAULT '',
              author TEXT DEFAULT '우리',
              visited INTEGER DEFAULT 0,
              rating INTEGER DEFAULT 5,
              created_at TEXT
            )
          `).run();

          const res = await env.DB.prepare("INSERT INTO couple_places (name, category, address, naver_map_url, notes, author, visited, rating, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(name, category, address, naverMapUrl, notes, author, visited, rating, nowIso).run();
          if (res && res.meta && res.meta.last_row_id) newId = res.meta.last_row_id;
        } catch (dbErr) {}

        const list = await getSettingJson('couple_places_json', []);
        list.unshift({
          id: newId,
          name,
          category,
          address,
          naver_map_url: naverMapUrl,
          notes,
          author,
          visited,
          rating,
          created_at: nowIso
        });
        await saveSettingJson('couple_places_json', list);

        return jsonResponse({ success: true, id: newId, naver_map_url: naverMapUrl }, 200);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/places" && request.method === "PUT") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const pId = parseInt(reqData.id, 10);
        if (!pId) return jsonResponse({ error: "유효한 장소 ID가 필요합니다." }, 400);

        // 토글 방문 여부 또는 전체 수정
        if (reqData.toggleVisited !== undefined) {
          const visitedVal = reqData.visited ? 1 : 0;
          try {
            await env.DB.prepare("UPDATE couple_places SET visited = ? WHERE id = ?").bind(visitedVal, pId).run();
          } catch(e) {}
          const list = await getSettingJson('couple_places_json', []);
          const target = list.find(item => Number(item.id) === pId);
          if (target) {
            target.visited = visitedVal;
            await saveSettingJson('couple_places_json', list);
          }
          return jsonResponse({ success: true, visited: visitedVal });
        }

        const name = String(reqData.name || '').trim();
        const category = String(reqData.category || '맛집').trim();
        const address = String(reqData.address || '').trim();
        let naverMapUrl = String(reqData.naver_map_url || reqData.naverMapUrl || '').trim();
        if (!naverMapUrl && name) {
          naverMapUrl = `https://map.naver.com/p/search/${encodeURIComponent(name)}`;
        }
        const notes = String(reqData.notes || '').trim();
        const visited = reqData.visited ? 1 : 0;
        const rating = parseInt(reqData.rating || 5, 10);

        try {
          await env.DB.prepare("UPDATE couple_places SET name = ?, category = ?, address = ?, naver_map_url = ?, notes = ?, visited = ?, rating = ? WHERE id = ?")
            .bind(name, category, address, naverMapUrl, notes, visited, rating, pId).run();
        } catch(e) {}

        const list = await getSettingJson('couple_places_json', []);
        const target = list.find(item => Number(item.id) === pId);
        if (target) {
          target.name = name;
          target.category = category;
          target.address = address;
          target.naver_map_url = naverMapUrl;
          target.notes = notes;
          target.visited = visited;
          target.rating = rating;
          await saveSettingJson('couple_places_json', list);
        }
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/places" && request.method === "DELETE") {
      try {
        const { id } = await request.json();
        const pId = parseInt(id, 10);
        try {
          await env.DB.prepare("DELETE FROM couple_places WHERE id = ?").bind(pId).run();
        } catch (e) {}

        const list = await getSettingJson('couple_places_json', []);
        const filtered = list.filter(item => Number(item.id) !== pId);
        await saveSettingJson('couple_places_json', filtered);
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 8. [하루 일정 계획 & 오늘 챙겨야 할 물품 메모 API] - /api/planner
    // 사용자 요청: "하루 일정계획을 정리할 수 있고 옆에 탭을 만들어서 오늘 챙겨야할 물품을 기록하는 메모 등의 항목들도 추가해줘" 지원
    if (url.pathname === "/api/planner" && request.method === "GET") {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS daily_planner (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_date TEXT NOT NULL UNIQUE,
            title TEXT DEFAULT '',
            timetable_json TEXT DEFAULT '[]',
            packing_items_json TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            created_at TEXT,
            updated_at TEXT
          )
        `).run();

        const reqDate = url.searchParams.get("date");
        if (reqDate) {
          const row = await env.DB.prepare("SELECT * FROM daily_planner WHERE plan_date = ?").bind(reqDate).first();
          if (row) {
            return jsonResponse(row);
          }
          // site_settings fallback
          const allPlans = await getSettingJson('daily_planner_json', {});
          return jsonResponse(allPlans[reqDate] || { plan_date: reqDate, timetable_json: '[]', packing_items_json: '[]', notes: '' });
        } else {
          // 전체 일정 조회
          const { results } = await env.DB.prepare("SELECT * FROM daily_planner ORDER BY plan_date DESC").all();
          if (results && results.length > 0) return jsonResponse(results);
          const allPlans = await getSettingJson('daily_planner_json', {});
          return jsonResponse(Object.values(allPlans));
        }
      } catch (e) {
        const reqDate = url.searchParams.get("date");
        const allPlans = await getSettingJson('daily_planner_json', {});
        if (reqDate) {
          return jsonResponse(allPlans[reqDate] || { plan_date: reqDate, timetable_json: '[]', packing_items_json: '[]', notes: '' });
        }
        return jsonResponse(Object.values(allPlans));
      }
    }

    if (url.pathname === "/api/planner" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const planDate = String(reqData.plan_date || reqData.planDate || new Date().toISOString().split('T')[0]).trim();
        const title = String(reqData.title || `${planDate} 데이트 계획`).trim();
        const timetableJson = typeof reqData.timetable_json === 'string' ? reqData.timetable_json : JSON.stringify(reqData.timetable || reqData.timetable_json || []);
        const packingJson = typeof reqData.packing_items_json === 'string' ? reqData.packing_items_json : JSON.stringify(reqData.packing_items || reqData.packing_items_json || []);
        const notes = String(reqData.notes || '').trim();
        const nowIso = new Date().toISOString();

        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS daily_planner (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              plan_date TEXT NOT NULL UNIQUE,
              title TEXT DEFAULT '',
              timetable_json TEXT DEFAULT '[]',
              packing_items_json TEXT DEFAULT '[]',
              notes TEXT DEFAULT '',
              created_at TEXT,
              updated_at TEXT
            )
          `).run();

          await env.DB.prepare(`
            INSERT INTO daily_planner (plan_date, title, timetable_json, packing_items_json, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(plan_date) DO UPDATE SET
              title = excluded.title,
              timetable_json = excluded.timetable_json,
              packing_items_json = excluded.packing_items_json,
              notes = excluded.notes,
              updated_at = excluded.updated_at
          `).bind(planDate, title, timetableJson, packingJson, notes, nowIso, nowIso).run();
        } catch (dbErr) {}

        const allPlans = await getSettingJson('daily_planner_json', {});
        allPlans[planDate] = {
          plan_date: planDate,
          title,
          timetable_json: timetableJson,
          packing_items_json: packingJson,
          notes,
          updated_at: nowIso
        };
        await saveSettingJson('daily_planner_json', allPlans);

        return jsonResponse({ success: true, plan_date: planDate }, 200);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/planner" && request.method === "DELETE") {
      try {
        const { date } = await request.json();
        if (date) {
          try {
            await env.DB.prepare("DELETE FROM daily_planner WHERE plan_date = ?").bind(date).run();
          } catch(e) {}
          const allPlans = await getSettingJson('daily_planner_json', {});
          delete allPlans[date];
          await saveSettingJson('daily_planner_json', allPlans);
        }
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 9. [사랑의 커플 쿠폰북 API] - /api/coupons
    if (url.pathname === "/api/coupons" && request.method === "GET") {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS couple_coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            issuer TEXT NOT NULL,
            receiver TEXT NOT NULL,
            status TEXT DEFAULT 'available',
            used_at TEXT DEFAULT '',
            created_at TEXT
          )
        `).run();
        const { results } = await env.DB.prepare("SELECT * FROM couple_coupons ORDER BY id DESC").all();
        if (results && results.length > 0) return jsonResponse(results);
        const fallback = await getSettingJson('couple_coupons_json', []);
        return jsonResponse(fallback);
      } catch(e) {
        const fallback = await getSettingJson('couple_coupons_json', []);
        return jsonResponse(fallback);
      }
    }

    if (url.pathname === "/api/coupons" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const action = reqData.action || 'create';

        if (action === 'use') {
          const cId = parseInt(reqData.id, 10);
          const usedAt = new Date().toISOString();
          try {
            await env.DB.prepare("UPDATE couple_coupons SET status = 'used', used_at = ? WHERE id = ?").bind(usedAt, cId).run();
          } catch(e) {}
          const list = await getSettingJson('couple_coupons_json', []);
          const target = list.find(item => Number(item.id) === cId);
          if (target) {
            target.status = 'used';
            target.used_at = usedAt;
            await saveSettingJson('couple_coupons_json', list);
          }
          return jsonResponse({ success: true, status: 'used', used_at: usedAt });
        }

        const title = String(reqData.title || '').trim();
        const description = String(reqData.description || '').trim();
        const issuer = String(reqData.issuer || '효니').trim();
        const receiver = String(reqData.receiver || (issuer === '효니' ? '히니' : '효니')).trim();
        const nowIso = new Date().toISOString();

        if (!title) return jsonResponse({ error: "쿠폰 이름을 입력해주세요." }, 400);

        let newId = Date.now();
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS couple_coupons (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              description TEXT DEFAULT '',
              issuer TEXT NOT NULL,
              receiver TEXT NOT NULL,
              status TEXT DEFAULT 'available',
              used_at TEXT DEFAULT '',
              created_at TEXT
            )
          `).run();

          const res = await env.DB.prepare("INSERT INTO couple_coupons (title, description, issuer, receiver, status, created_at) VALUES (?, ?, ?, ?, 'available', ?)")
            .bind(title, description, issuer, receiver, nowIso).run();
          if (res && res.meta && res.meta.last_row_id) newId = res.meta.last_row_id;
        } catch(e) {}

        const list = await getSettingJson('couple_coupons_json', []);
        list.unshift({
          id: newId,
          title,
          description,
          issuer,
          receiver,
          status: 'available',
          used_at: '',
          created_at: nowIso
        });
        await saveSettingJson('couple_coupons_json', list);

        return jsonResponse({ success: true, id: newId }, 200);
      } catch(e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/coupons" && request.method === "DELETE") {
      try {
        const { id } = await request.json();
        const cId = parseInt(id, 10);
        try {
          await env.DB.prepare("DELETE FROM couple_coupons WHERE id = ?").bind(cId).run();
        } catch(e) {}
        const list = await getSettingJson('couple_coupons_json', []);
        const filtered = list.filter(item => Number(item.id) !== cId);
        await saveSettingJson('couple_coupons_json', filtered);
        return jsonResponse({ success: true });
      } catch(e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 10. [R2 버킷 미디어 서빙]
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const fileName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(fileName);
      if (!object) return new Response("Not found", { status: 404 });
      
      const headers = new Headers(); 
      object.writeHttpMetadata(headers); 
      headers.set("etag", object.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "public, max-age=86400");
      
      return new Response(object.body, { headers });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
