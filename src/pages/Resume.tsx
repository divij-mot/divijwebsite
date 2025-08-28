import { ThemeToggle } from '../components/ThemeToggle';

function Resume() {
  return (
    <div className="h-screen flex flex-col">
      {/* Theme Toggle positioned above PDF */}
      <div className="flex justify-end p-4 pb-0">
        <ThemeToggle />
      </div>
      
      {/* PDF Viewer Container - Full Size */}
      <div className="flex-1 w-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
        <iframe
          src="/resume.pdf"
          width="100%"
          height="100%"
          title="Divij Motwani Resume"
          aria-label="Divij Motwani's Resume PDF Viewer"
          className="border-0 w-full h-full"
          style={{ 
            display: 'block',
            border: 'none',
          }}
        >
          <p className="p-4 text-neutral-600 dark:text-neutral-400">
            Your browser does not support PDFs. 
            <a 
              href="/resume.pdf" 
              className="text-blue-500 hover:underline ml-1"
              download="Divij_Motwani_Resume.pdf"
            >
              Please download the PDF to view it.
            </a>
          </p>
        </iframe>
      </div>
      
      {/* SEO and Accessibility Content for Auto-Screening Systems */}
      <div className="sr-only" aria-hidden="true">
        <h2>Resume Content Summary</h2>
        <p>
          This page contains the resume of Divij Motwani, an 18-year-old EECS student at UC Berkeley.
          The resume includes education, experience, projects, skills, and contact information.
          Key highlights include founding a STEM publication, competing at the Regeneron International 
          Science and Engineering Fair with OralAI (First Place Grand Award winner), and various 
          technical projects and achievements.
        </p>
        <p>
          Technical skills include programming languages, frameworks, and tools relevant to software 
          engineering and computer science. The resume is available in PDF format for download and 
          is optimized for applicant tracking systems (ATS) and auto-screening processes.
        </p>
        <p>
          Contact information and additional details about projects, coursework, and achievements 
          are included in the PDF document above.
        </p>
      </div>

      {/* Structured Data for SEO and Auto-Screening */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Person",
          "name": "Divij Motwani",
          "jobTitle": "EECS Student",
          "url": "https://divijmotwani.com/resume",
          "sameAs": [
            "https://divijmotwani.com"
          ],
          "affiliation": {
            "@type": "Organization",
            "name": "UC Berkeley",
            "url": "https://berkeley.edu"
          },
          "description": "18-year-old EECS student at UC Berkeley with experience in software engineering, AI/ML, and technical innovation.",
          "hasCredential": {
            "@type": "EducationalOccupationalCredential",
            "name": "EECS Program",
            "educationalLevel": "Undergraduate",
            "credentialCategory": "degree"
          }
        })
      }} />
    </div>
  );
}

export default Resume;
