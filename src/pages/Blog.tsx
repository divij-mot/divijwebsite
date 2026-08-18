import { WritingList } from '../components/WritingList';

function Blog() {
  return (
    <div className="max-w-2xl lg:max-w-3xl pt-12 pb-16">
      <h1 className="text-5xl font-bold mb-12">Blog</h1>
      <WritingList variant="site" />
    </div>
  );
}

export default Blog;
