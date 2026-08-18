export type Writing = {
  id: string;
  title: string;
  date: string;
  url: string;
  description: string;
  with: string;
};

export const writings: Writing[] = [
  {
    id: 'period',
    title: 'period',
    date: 'March 2026',
    url: 'https://therefore.sh/projects/period',
    description:
      'An end-to-end car parking world model with 11M parameters that runs at 120hz on a MacBook.',
    with: 'Ashray Gupta, Warren Yun, Joey Ruan, and Rohan Kalia',
  },
  {
    id: 'dva',
    title: 'Causal Video Generation as a Policy',
    date: 'March 2026',
    url: 'https://www.beepbooprobotics.com/posts/causal-video-generation',
    description:
      'A direct video action model created to model and dream/act in the push-t environment',
    with: 'Rohan Kalia',
  },
];
