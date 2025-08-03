export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '/unknown';
    
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    
    if (!openrouterApiKey) {
      console.error('OpenRouter API key not found');
      return new Response('Server configuration error', { status: 500 });
    }

    const prompt = `You are an AI that generates complete, single-file, self-contained HTML web pages on the fly. The user has navigated to the URL path: "${path}".

Your Task: Based on the path, generate a creative, surprising, and fully functional webpage. The page should be a complete HTML document, including inline <style> tags for CSS and inline <script> tags for any necessary JavaScript.

Guidelines:
- Be Creative: The path is a creative seed. "/nuclear-launch-site" could be a retro terminal. "/a-quiet-place" could be a minimalist meditation page. "/snakegame" could be a playable snake game with WASD controls and mobile touch support.
- Self-Contained: All CSS and JS must be inline. Do not use external file links or CDNs.
- Functional: If you create interactive elements, make them work with JavaScript.
- Mobile-Friendly: Ensure the page works well on both desktop and mobile devices. For games, include touch controls, virtual joysticks, or tap-based interactions as appropriate.
- Responsive: Use responsive design principles with CSS media queries.
- Modern: Use modern HTML5, CSS3, and ES6+ JavaScript features.
- IMPORTANT: Your entire response must ONLY be the raw HTML code. Do not include any explanations, markdown formatting like \`\`\`html, or any text outside of the <!DOCTYPE html>...</html> document.

Now, generate the HTML for the path: "${path}"`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000',
        'X-Title': 'QuantumPage Generator',
      },
      body: JSON.stringify({
        model: 'openrouter/horizon-beta',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 8000,
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('OpenRouter API error:', response.status, errorData);
      return new Response('Failed to generate content', { status: 500 });
    }

    const data = await response.json();
    const htmlContent = data.choices[0]?.message?.content;

    if (!htmlContent) {
      console.error('No content generated from OpenRouter');
      return new Response('No content generated', { status: 500 });
    }

    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });

  } catch (error) {
    console.error('Error in generate function:', error);
    return new Response('Internal server error', { status: 500 });
  }
}