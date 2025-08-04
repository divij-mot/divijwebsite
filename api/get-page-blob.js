import { head } from '@vercel/blob';

// Use Node.js runtime for better compatibility with Vercel Blob
export const config = {
  runtime: 'nodejs',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { uuid } = req.query;
    
    if (!uuid) {
      return res.status(400).json({ error: 'Missing UUID parameter' });
    }

    console.log(`Retrieving page with UUID: ${uuid}`);
    
    // Check if blob exists and get its info
    try {
      const blobInfo = await head(`quantumpage/${uuid}.html`);
      
      if (!blobInfo) {
        return res.status(404).send('Page not found or expired');
      }
      
      console.log(`Found blob: ${blobInfo.url}`);
      
      // Fetch the content from the blob URL
      const response = await fetch(blobInfo.url);
      
      if (!response.ok) {
        throw new Error('Failed to fetch blob content');
      }
      
      const htmlContent = await response.text();
      
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(htmlContent);
      
    } catch (blobError) {
      console.log('Blob not found:', blobError.message);
      return res.status(404).send('Page not found or expired');
    }

  } catch (error) {
    console.error('Error retrieving page:', error);
    return res.status(404).send('Page not found or expired');
  }
}