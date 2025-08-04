import { put } from '@vercel/blob';

// Use Node.js runtime for better compatibility with Vercel Blob
export const config = {
  runtime: 'nodejs',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { content, title } = req.body;
    
    if (!content || !title) {
      return res.status(400).json({ error: 'Missing content or title' });
    }

    // Generate a UUID for the permanent link
    const uuid = crypto.randomUUID();
    
    console.log(`Saving page with UUID: ${uuid}, Title: ${title}, Content length: ${content.length}`);
    
    // Create metadata object
    const metadata = {
      title,
      createdAt: new Date().toISOString(),
      uuid
    };
    
    // Save HTML content to Vercel Blob
    const blob = await put(`quantumpage/${uuid}.html`, content, {
      access: 'public',
      addRandomSuffix: false,
      metadata
    });
    
    console.log(`Page saved to blob: ${blob.url}`);
    
    return res.status(200).json({ 
      uuid,
      message: 'Page saved successfully',
      link: `/quantumpage/${uuid}`,
      blobUrl: blob.url
    });

  } catch (error) {
    console.error('Error saving page:', error);
    return res.status(500).json({ error: `Internal server error: ${error.message}` });
  }
}