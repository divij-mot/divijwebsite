export const config = {
  runtime: 'edge',
};

// Simple in-memory storage for testing (not persistent)
const pageStorage = new Map();

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { content, title } = await request.json();
    
    if (!content || !title) {
      return new Response('Missing content or title', { status: 400 });
    }

    // Generate a UUID for the permanent link
    const uuid = crypto.randomUUID();
    
    console.log(`Saving page with UUID: ${uuid}, Title: ${title}, Content length: ${content.length}`);
    
    // For now, store in memory (will be lost on deployment)
    // TODO: Implement proper Vercel Blob storage once Edge Runtime issues are resolved
    pageStorage.set(uuid, {
      content,
      title,
      createdAt: new Date().toISOString()
    });
    
    console.log(`Page saved with UUID: ${uuid}`);
    
    return new Response(JSON.stringify({ 
      uuid,
      message: 'Page saved successfully (temporary)',
      link: `/quantumpage/${uuid}`
    }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });

  } catch (error) {
    console.error('Error saving page:', error);
    return new Response(`Internal server error: ${error.message}`, { status: 500 });
  }
}