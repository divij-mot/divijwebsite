import React from 'react';

function About() {
  return (
    <div className="max-w-2xl lg:max-w-4xl pt-12">
      <h1 className="text-5xl font-bold mb-6">About Me</h1>
      <div className="prose prose-neutral dark:prose-invert space-y-5">
        <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed">
          I'm an EECS student at UC Berkeley. This summer I'm an FDE intern at Palantir.
        </p>
        <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed">
          A lot of my recent work has been about making small models do physical things: period, an end-to-end car parking world model, and a direct video action model for the push-t environment. Before that I worked on retrieval — <a href="https://papers.nips.cc/paper_files/paper/2025/hash/ed25c00ff6900989116d3ba5d607d33d-Abstract-Datasets_and_Benchmarks_Track.html" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">RAGuard</a>, a benchmark for how RAG fails on misleading evidence, went to NeurIPS 2025 — and on <a href="https://oralai.tech" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">OralAI</a>, a dental imaging system that won first place in Biomedical Engineering at ISEF.
        </p>
        <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed">
          In high school I founded <a href="https://issuu.com/palyveritas" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">Paly Veritas</a>, a STEM publication covering Bay Area tech. I still like writing; some of it lives on the <a href="/blog" className="text-blue-500 hover:underline">blog</a>. I also spend time with Blockchain at Berkeley.
        </p>
      </div>
    </div>
  );
}

export default About;
