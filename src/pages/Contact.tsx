import React from 'react';
import { Linkedin, Twitter, Mail } from 'lucide-react';

function Contact() {
  return (
    <div className="max-w-2xl lg:max-w-4xl pt-12">
      <h1 className="text-5xl font-bold mb-6">Contact</h1>
      <div className="prose prose-neutral dark:prose-invert">
        <p className="text-lg text-neutral-600 dark:text-neutral-400 mb-8">
          Just send me a message:
        </p>
        <ul className="space-y-4">
          <li className="flex items-center">
            <a href="https://www.linkedin.com/in/divijmotwani" className="text-blue-500 hover:underline">
              LinkedIn
            </a>
          </li>
          <li className="flex items-center">
            <a href="https://x.com/DivijMot" className="text-blue-500 hover:underline">
              Twitter
            </a>
          </li>
          <li className="flex items-center">
              divijmotwani [at] gmail [dot] com
          </li>
        </ul>
      </div>
    </div>
  );
}

export default Contact;