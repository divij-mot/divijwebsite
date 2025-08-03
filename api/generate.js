export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  console.log('Function invoked, method:', request.method);
  
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '/unknown';
    console.log('Path parameter:', path);
    
    // Quick test mode - uncomment to test function is working
    // return new Response(`<html><body><h1>Function working! Path: ${path}</h1></body></html>`, {
    //   headers: { 'Content-Type': 'text/html' }
    // });
    
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    
    if (!openrouterApiKey) {
      console.error('OpenRouter API key not found');
      return new Response('Server configuration error: API key not found', { status: 500 });
    }
    
    console.log('API key found, length:', openrouterApiKey.length);

    const prompt = `You are an AI that generates complete, single-file, self-contained HTML web pages on the fly. The user has navigated to the URL path: "${path}".

Your Task: Based on the path, generate a creative, surprising, and fully functional webpage. The page should be a complete HTML document, including inline <style> tags for CSS and inline <script> tags for any necessary JavaScript.

Guidelines:
- Be Creative: The path is a creative seed. "/nuclear-launch-site" could be a retro terminal. "/a-quiet-place" could be a minimalist meditation page. "/snakegame" could be a playable snake game with WASD controls and mobile touch support.
- Self-Contained: All CSS and JS must be inline. Do not use external file links or CDNs. 
- MAKE SURE THE PAGE IS RESPONSIVE TO SIZE OF SCREEN. If screen is smaller, make the page smaller, and if screen is larger, make the page larger. BUT ALSO MAKE SURE THAT THE COMPONENTS ARE NOT truncated due to size. Do not cutoff any components, make sure all parts are responsive
- COMPONENTS KEEP GETTING CUT OFF. For example a game screen for snake should fit on the screen without any parts being cutoff. If you are doing a game, make sure the game is responsive and fits on the screen without any parts being cutoff (so make sure internal components are also responsive)
- Functional: If you create interactive elements, make them work with JavaScript. ENSURE ALL JAVASCRIPT IS COMPLETE AND FUNCTIONAL.
- Mobile-Friendly: Ensure the page works well on both desktop and mobile devices. For games, include touch controls, virtual joysticks, or tap-based interactions as appropriate. Remember that on mobile screens are smaller, and you cant scroll, so if doing joystick for a game or something, put it on the main display instead of making a separate joystick section, or make the website smaller.
- Responsive: Use responsive design principles with CSS media queries.
- Modern: Use modern HTML5, CSS3, and ES6+ JavaScript features.
- CRITICAL: If creating a game or complex interactive element, prioritize completing the core functionality over visual polish. A working simple game is better than a beautiful broken one. Make sure scores, buttons, movement, etc. are all working and fit on the screen no matter size.
- ESSENTIAL: Always end with a proper closing </html> tag. Never cut off mid-function or mid-tag.
- LENGTH: THE PAGE SHOULD BE a MAX of 12000 tokens output,
- IMPORTANT: Your entire response must ONLY be the raw HTML code. Do not include any explanations, markdown formatting like \`\`\`html, or any text outside of the <!DOCTYPE html>...</html> document.

Now, generate the HTML for the path: "${path}"`;

    console.log('Making request to OpenRouter...');
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000',
        'X-Title': 'QuantumPage Generator',
      },
      body: JSON.stringify({
        model: 'openrouter/horizon-beta', // Using a reliable model
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 15000, // Increased for complex games/interactive content
        temperature: 0.5,
        stream: true, // Enable streaming to prevent timeout
      }),
    });
    
    console.log('OpenRouter response status:', response.status);

    if (!response.ok) {
      const errorData = await response.text();
      console.error('OpenRouter API error:', response.status, errorData);
      return new Response('Failed to generate content', { status: 500 });
    }

    console.log('Processing streaming response and keeping connection alive...');
    
    // Create a stream that sends progress updates but only returns final HTML
    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) {
          controller.error(new Error('No response body'));
          return;
        }

        let fullContent = '';
        let chunkCount = 0;
        let buffer = ''; // Buffer to accumulate partial chunks
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk; // Add to buffer
            
            // Process complete lines from buffer
            const lines = buffer.split('\n');
            // Keep the last incomplete line in buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                  console.log('Received [DONE] signal');
                  continue;
                }
                
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    fullContent += content;
                    chunkCount++;
                    
                    if (chunkCount <= 5) {
                      console.log('Content chunk:', content.substring(0, 50) + '...');
                    }
                    
                    // Send periodic progress updates to keep connection alive
                    // But don't send the actual HTML content yet
                    if (chunkCount % 20 === 0) {
                      console.log(`Progress update: ${chunkCount} chunks`);
                      const progressMsg = `<!-- Progress: ${chunkCount} chunks received -->`;
                      controller.enqueue(new TextEncoder().encode(progressMsg));
                    }
                  }
                } catch (e) {
                  console.log('Failed to parse JSON line:', data.substring(0, 100) + '...');
                }
              }
            }
          }
          
          console.log('Stream ended. Total chunks:', chunkCount, 'Content length:', fullContent.length);

          // Now send the complete HTML content all at once
          if (fullContent.trim()) {
            console.log('Sending complete HTML, length:', fullContent.length);
            
            // Check if content was truncated (doesn't end with </html>)
            const trimmedContent = fullContent.trim();
            if (!trimmedContent.endsWith('</html>')) {
              console.log('Content appears truncated, attempting to complete it');
              
              // Try to close any open tags gracefully
              let fixedContent = trimmedContent;
              
              // If it ends mid-tag or mid-function, add basic closure
              if (!fixedContent.includes('</script>') && fixedContent.includes('<script')) {
                fixedContent += '\n</script>';
              }
              if (!fixedContent.includes('</body>') && fixedContent.includes('<body')) {
                fixedContent += '\n</body>';
              }
              if (!fixedContent.endsWith('</html>')) {
                fixedContent += '\n</html>';
              }
              
              // Inject home button before closing body tag
              const homeButton = `
<div id="quantum-home-btn" style="position: fixed; top: 20px; left: 20px; z-index: 9999; opacity: 1.25; transition: opacity 0.3s ease; cursor: pointer; width: 40px; height: 40px; background: rgba(0,0,0,0.7); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);" onmouseover="this.style.opacity='2.0'" onmouseout="this.style.opacity='1.25'" ontouchstart="this.style.opacity='2.0'" ontouchend="setTimeout(()=>this.style.opacity='1.25',2000)" onclick="window.location.href='/tools/quantumpage'">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style="pointer-events: none;">
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
  </svg>
</div>`;
              
              fixedContent = fixedContent.replace('</body>', homeButton + '\n</body>');
              
              controller.enqueue(new TextEncoder().encode(fixedContent));
            } else {
              // Content looks complete - still inject home button
              const homeButton = `
<div id="quantum-home-btn" style="position: fixed; top: 20px; left: 20px; z-index: 9999; opacity: 1.25; transition: opacity 0.3s ease; cursor: pointer; width: 40px; height: 40px; background: rgba(0,0,0,0.7); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);" onmouseover="this.style.opacity='2.0'" onmouseout="this.style.opacity='1.25'" ontouchstart="this.style.opacity='2.0'" ontouchend="setTimeout(()=>this.style.opacity='1.25',2000)" onclick="window.location.href='/tools/quantumpage'">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style="pointer-events: none;">
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
  </svg>
</div>`;
              
              const contentWithHomeBtn = fullContent.replace('</body>', homeButton + '\n</body>');
              controller.enqueue(new TextEncoder().encode(contentWithHomeBtn));
            }
          } else {
            controller.error(new Error('No content generated'));
          }

        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
          controller.close();
        }
      }
    });

    return new Response(stream, {
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