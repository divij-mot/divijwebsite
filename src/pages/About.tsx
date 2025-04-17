import React from 'react';

function About() {
  return (
    <div className="max-w-2xl lg:max-w-4xl pt-12">
      <h1 className="text-5xl font-bold mb-6">About Me</h1>
      <div className="prose prose-neutral dark:prose-invert">
        <ul className="space-y-3 ml-4">
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              WIP.
            </span>
          </li>
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              WIP.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

export default About;