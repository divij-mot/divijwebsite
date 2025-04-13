import React from 'react';
import { Linkedin, Twitter, Mail } from 'lucide-react';

function Contact() {
  return (
    <div className="max-w-2xl lg:max-w-4xl pt-12">
      <h1 className="text-5xl font-bold mb-6">Contact Me</h1>
      <div className="prose prose-neutral dark:prose-invert">
        <p className="text-lg text-neutral-600 dark:text-neutral-400 mb-8">
          Feel free to reach out through any of the platforms below:
        </p>
        <ul className="space-y-4">
          <li className="flex items-center">
            <Linkedin className="w-5 h-5 mr-3 text-neutral-500 dark:text-neutral-400" />
            <a href="#" className="text-blue-500 hover:underline">
              LinkedIn (Placeholder Link)
            </a>
          </li>
          <li className="flex items-center">
            <Twitter className="w-5 h-5 mr-3 text-neutral-500 dark:text-neutral-400" />
            <a href="#" className="text-blue-500 hover:underline">
              Twitter (Placeholder Link)
            </a>
          </li>
          <li className="flex items-center">
            <Mail className="w-5 h-5 mr-3 text-neutral-500 dark:text-neutral-400" />
            <a href="mailto:placeholder@example.com" className="text-blue-500 hover:underline">
              Email (placeholder@example.com)
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}

export default Contact;