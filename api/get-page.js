export const config = {
  runtime: 'edge',
};

// Reference to the same in-memory storage (will be empty after deployment)
// This is shared across function invocations within the same runtime
const pageStorage = new Map();

export default async function handler(request) {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const uuid = url.searchParams.get('uuid');
    
    if (!uuid) {
      return new Response('Missing UUID parameter', { status: 400 });
    }

    console.log(`Retrieving page with UUID: ${uuid}`);
    
    // Get from memory storage
    const pageData = pageStorage.get(uuid);
    
    if (!pageData) {
      console.log(`Page with UUID ${uuid} not found in storage`);
      return new Response('Page not found or expired', { status: 404 });
    }
    
    console.log(`Found page: ${pageData.title}`);
    
    return new Response(pageData.content, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });

  } catch (error) {
    console.error('Error retrieving page:', error);
    return new Response('Page not found or expired', { status: 404 });
  }
}