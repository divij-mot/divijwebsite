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

Your Task
Generate a creative, surprising, and fully functional webpage **as a single HTML document** with all CSS in \`<style>\` and all JS in \`<script>\`. The output must be **only** the raw HTML document, starting with \`<!DOCTYPE html>\` and ending with \`</html>\`.

Creative seed
Use the path as the concept. Examples:
- \`/nuclear-launch-site\` → retro terminal.
- \`/a-quiet-place\` → minimalist meditation page.
- \`/snakegame\` → fully playable Snake with keyboard + touch.

Non-negotiables
- **Self-contained:** No external files, libraries, fonts, images, or CDNs.
- **Mobile-friendly & responsive:** Must look and work on phones, tablets, and desktops.
- **No truncation ever:** Nothing may render off-screen or be cut off. If space is tight, **scale down** or **reflow**, don't overflow.
- **Functional:** Any interactive elements (games, controls, buttons) must work with complete, bug-free JavaScript.
- **Performance:** Use modern HTML5/CSS3/ES6. Avoid heavy effects. Prioritize smooth interaction.
- **Length cap:** Keep total output ≤ 12,000 tokens.
- **Length2:** USE ALL THE TOKENS YOU CAN, IMPLEMENT ALL THE FUNCTIONALIRTY YOU CAN MAKE IT GOOD LOOKING ETC. IT SHOULD NOT BE BASIC.

Global layout rules (apply to every page)
1. Include \`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\`.
2. Use \`html, body { height: 100dvh; }\` (not bare \`100vh\`) and \`overflow: hidden\` when the page is a single-screen app (e.g., games). If the page is scrolly content, allow vertical scroll but **never** horizontal scroll.
3. Wrap everything in a centered container with padding that respects safe areas:
   - \`padding: max(12px, env(safe-area-inset-top))\` etc. for all sides.
   - \`box-sizing: border-box\` everywhere.
4. Use fluid sizes with \`clamp()\`/\`min()\`/\`max()\` for text and UI. Example: \`font-size: clamp(14px, 2.2vmin, 20px)\`.
5. Ensure all UI (score, buttons, overlays) auto-wrap/stack on small screens. Do not rely on fixed pixel positions.
6. Never rely on the page scrolling to reveal controls. If needed, **scale the whole interactive area** or **show a collapsible help overlay**, but keep everything within the viewport.

Anti-truncation rules for interactive canvases/games (must follow)
- The **play area must always fit** inside its parent without cropping. Prefer letterboxing (empty margins) over overflow.
- **Do not hard-code canvas size.** Compute it from the current container size whenever the page loads, resizes, or rotates.
- **Sizing algorithm (implement exactly):**
  1. Measure available inner size of the game container (width, height) after UI padding/margins: \`const w = container.clientWidth; const h = container.clientHeight;\`
  2. Choose the playfield size: \`const size = Math.min(w, h);\`
  3. For grid games (e.g., Snake/Tetris), choose a maximum logical grid (e.g., 20–40 cells per side). Compute integer cell size: \`cell = Math.floor(size / cells); canvasSize = cell * cells;\`
  4. Set \`canvas.width = canvasSize; canvas.height = canvasSize;\` and center it with flexbox. This guarantees no fractional pixels and no cropping.
  5. On \`resize\`/\`orientationchange\`, recompute steps 1–4 and redraw. Keep game state independent of pixel size (logical units).
- If additional UI (score, buttons, joystick) would push the canvas off-screen, **reduce the canvas size first**. Only then, if necessary, scale down UI text via \`clamp()\`.
- **No absolute positioning that can overflow**. If you must overlay (e.g., pause dialog), use an inset flex container with \`inset: 0; display: grid; place-items: center;\` and ensure it can shrink.
- **Touch support:** For games, include on-screen controls that live **within the same container** as the canvas and scale with it. Do not create a separate section that forces scrolling.

Controls & accessibility
- Keyboard: support arrows and WASD where relevant.
- Touch: tap, swipe, or a minimal virtual D-pad/joystick. Controls must be big enough: \`min(44px)\` target with \`clamp()\`.
- Provide a visible **Restart** and **Pause** button for games.
- Announce score/level updates visually; avoid blocking modals.
- Prevent default browser scrolling on game gestures: call \`e.preventDefault()\` on touch/arrow key inputs where needed.

Quality checklist (must pass before output)
- No element requires scrolling to be fully visible on phones in portrait.
- Resizing the browser never causes components to clip or go off-screen.
- Canvas is recreated/rescaled on resize without distorting the logical game.
- All JS referenced objects exist before use (no undefined errors).
- The document ends with a proper closing \`</html>\` tag. No stray backticks or markdown.
- Make all sites cool, try not to make basic games or websites, add functionality make it in depth, you have 12000 tokens to work with so make a polished system, remembering that functionality always comes first.
- DONT HAVE THE URL PATH VISIBLE AS THE TITLE OR ANYTHING, No need for a title, just make it cool and functional.

Output format
- **IMPORTANT:** Your entire response must be the raw HTML only. Do not wrap it in Markdown fences. Do not add commentary, explanations, or extra text outside the HTML.
- The page must contain inline \`<style>\` and \`<script>\` sections implementing the above, with sensible defaults and comments kept brief.

Examples of path handling (you decide final design; these are guides, not templates)
- \`/snakegame\`: square canvas sized with the algorithm above; score bar and D-pad stacked responsively; no cropping; works with keyboard, touch, and resize.
- \`/a-quiet-place\`: full-screen breathing animation; controls auto-scale and never overflow.
- \`/nuclear-launch-site\`: terminal UI that scales typography via \`clamp()\`; input and log never exceed viewport.

Remember: if space is constrained, **scale down and reflow**; never cut off components; never require scrolling for single-screen interactives.

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
        model: 'anthropic/claude-sonnet-4.5', // Using a reliable model
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 20000, // Increased for complex games/interactive content
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
              
              // Inject home button and share button before closing body tag
              const homeButton = `
<div id="quantum-home-btn" style="position: fixed; top: 20px; left: 20px; z-index: 9999; opacity: 1.25; transition: opacity 0.3s ease; cursor: pointer; width: 40px; height: 40px; background: rgba(0,0,0,0.7); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);" onmouseover="this.style.opacity='2.0'" onmouseout="this.style.opacity='1.25'" ontouchstart="this.style.opacity='2.0'" ontouchend="setTimeout(()=>this.style.opacity='1.25',2000)" onclick="window.location.href='/tools/quantumpage'">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style="pointer-events: none;">
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
  </svg>
</div>
<div id="quantum-share-btn" style="position: fixed; top: 20px; right: 20px; z-index: 9999; opacity: 1.25; transition: opacity 0.3s ease; cursor: pointer; width: 40px; height: 40px; background: rgba(0,0,0,0.7); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);" onmouseover="this.style.opacity='2.0'" onmouseout="this.style.opacity='1.25'" ontouchstart="this.style.opacity='2.0'" ontouchend="setTimeout(()=>this.style.opacity='1.25',2000)" onclick="shareCurrentPage()">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style="pointer-events: none;">
    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.50-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/>
  </svg>
</div>
<script>
async function shareCurrentPage() {
  try {
    const content = document.documentElement.outerHTML;
    const title = document.title || 'QuantumPage';
    
    const response = await fetch('/api/save-page-blob', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, title })
    });
    
    if (response.ok) {
      const data = await response.json();
      const fullUrl = window.location.origin + data.link;
      
      // Always copy to clipboard, no web share API
      await navigator.clipboard.writeText(fullUrl);
      
      // Show a nice notification
      showShareNotification('Permanent link copied!');
    } else {
      showShareNotification('Failed to create permanent link', true);
    }
  } catch (error) {
    console.error('Share error:', error);
    showShareNotification('Failed to share page', true);
  }
}

function showShareNotification(message, isError = false) {
  // Remove existing notification if any
  const existing = document.getElementById('quantum-share-notification');
  if (existing) existing.remove();
  
  // Create notification
  const notification = document.createElement('div');
  notification.id = 'quantum-share-notification';
  notification.style.cssText = \`
    position: fixed;
    top: 70px;
    right: 20px;
    background: \${isError ? 'rgba(220, 38, 38, 0.95)' : 'rgba(34, 197, 94, 0.95)'};
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    z-index: 10000;
    backdrop-filter: blur(10px);
    transform: translateX(100%);
    transition: transform 0.3s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  \`;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  // Animate in
  setTimeout(() => {
    notification.style.transform = 'translateX(0)';
  }, 10);
  
  // Animate out and remove
  setTimeout(() => {
    notification.style.transform = 'translateX(100%)';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }, 3000);
}
</script>`;
              
              fixedContent = fixedContent.replace('</body>', homeButton + '\n</body>');
              
              controller.enqueue(new TextEncoder().encode(fixedContent));
            } else {
              // Content looks complete - still inject home button and share button
              const homeButton = `
<div id="quantum-home-btn" style="position: fixed; top: 20px; left: 20px; z-index: 9999; opacity: 1.25; transition: opacity 0.3s ease; cursor: pointer; width: 40px; height: 40px; background: rgba(0,0,0,0.7); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);" onmouseover="this.style.opacity='2.0'" onmouseout="this.style.opacity='1.25'" ontouchstart="this.style.opacity='2.0'" ontouchend="setTimeout(()=>this.style.opacity='1.25',2000)" onclick="window.location.href='/tools/quantumpage'">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style="pointer-events: none;">
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
  </svg>
</div>
<div id="quantum-share-btn" style="position: fixed; top: 20px; right: 20px; z-index: 9999; opacity: 1.25; transition: opacity 0.3s ease; cursor: pointer; width: 40px; height: 40px; background: rgba(0,0,0,0.7); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);" onmouseover="this.style.opacity='2.0'" onmouseout="this.style.opacity='1.25'" ontouchstart="this.style.opacity='2.0'" ontouchend="setTimeout(()=>this.style.opacity='1.25',2000)" onclick="shareCurrentPage()">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style="pointer-events: none;">
    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.50-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/>
  </svg>
</div>
<script>
async function shareCurrentPage() {
  try {
    const content = document.documentElement.outerHTML;
    const title = document.title || 'QuantumPage';
    
    const response = await fetch('/api/save-page-blob', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, title })
    });
    
    if (response.ok) {
      const data = await response.json();
      const fullUrl = window.location.origin + data.link;
      
      // Always copy to clipboard, no web share API
      await navigator.clipboard.writeText(fullUrl);
      
      // Show a nice notification
      showShareNotification('Permanent link copied!');
    } else {
      showShareNotification('Failed to create permanent link', true);
    }
  } catch (error) {
    console.error('Share error:', error);
    showShareNotification('Failed to share page', true);
  }
}

function showShareNotification(message, isError = false) {
  // Remove existing notification if any
  const existing = document.getElementById('quantum-share-notification');
  if (existing) existing.remove();
  
  // Create notification
  const notification = document.createElement('div');
  notification.id = 'quantum-share-notification';
  notification.style.cssText = \`
    position: fixed;
    top: 70px;
    right: 20px;
    background: \${isError ? 'rgba(220, 38, 38, 0.95)' : 'rgba(34, 197, 94, 0.95)'};
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    z-index: 10000;
    backdrop-filter: blur(10px);
    transform: translateX(100%);
    transition: transform 0.3s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  \`;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  // Animate in
  setTimeout(() => {
    notification.style.transform = 'translateX(0)';
  }, 10);
  
  // Animate out and remove
  setTimeout(() => {
    notification.style.transform = 'translateX(100%)';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }, 3000);
}
</script>`;
              
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