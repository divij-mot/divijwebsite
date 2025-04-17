import React from 'react';

function Blog() {
  return (
    <div className="max-w-2xl lg:max-w-4xl pt-12">
      <h1 className="text-5xl font-bold mb-6">Blog</h1>
      <div className="prose prose-neutral dark:prose-invert">
        <h2 className="text-2xl font-semibold mb-4">Placeholder Blog Post</h2>
        <p className="text-neutral-600 dark:text-neutral-400">
          WIP <a href="#" className="text-blue-500 hover:underline">here</a> (link currently inactive).
        </p>
      </div>
    </div>
  );
}

export default Blog;