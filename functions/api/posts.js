export async function onRequestGet(context) {
  const { results } = await context.env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC").all();
  return Response.json(results);
}

export async function onRequestPost(context) {
  const formData = await context.request.formData();
  const author = formData.get("author");
  const content = formData.get("content");
  const image = formData.get("image");

  let imageUrl = "";
  if (image && image.name) {
    const fileName = `${Date.now()}-${image.name}`;
    await context.env.BUCKET.put(fileName, image.stream());
    imageUrl = `/api/images/${fileName}`;
  }

  await context.env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)").bind(author, content, imageUrl).run();
  return new Response("OK", { status: 200 });
}
