import { WritingList } from '../components/WritingList';

function Blog() {
  return (
    <div className="max-w-2xl lg:max-w-3xl pt-12 pb-16">
      <h1 className="text-5xl font-bold mb-3">Blog</h1>
      <p className="text-neutral-600 dark:text-neutral-400 italic mb-12">
        Notes from work I was in the middle of.
      </p>
      <WritingList variant="site" />
    </div>
  );
}

export default Blog;
