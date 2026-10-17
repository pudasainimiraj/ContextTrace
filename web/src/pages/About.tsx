import { Link } from "../components/Link.tsx";

export default function AboutPage() {
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        How ContextTrace works
      </h1>
      <p className="lede">
        Code tells you what. Discussions tell you why. ContextTrace indexes the issues and pull requests of a public GitHub repository so you can search the reasoning by meaning and jump to the exact comment.
      </p>
      <section className="section" aria-labelledby="indexed-title">
        <div className="section-head">
          <h2 id="indexed-title">What is indexed</h2>
        </div>
        <ul>
          <li>Public repositories only.</li>
          <li>Issues, pull requests, their comments and their review comments, as text. Each passage keeps the author's public login and a link to the comment.</li>
          <li>Never the code, never raw HTML, never anything from a private repository.</li>
        </ul>
      </section>
      <section className="section" aria-labelledby="search-title">
        <div className="section-head">
          <h2 id="search-title">How search decides</h2>
        </div>
        <p>
          The query is compared by meaning with every passage. Close matches are shown as strong. When nothing is close, passages that contain the words are shown instead and marked as keyword matches. Weak matches are shown with a warning, and when nothing supports the query the page says so rather than guessing.
        </p>
      </section>
      <section className="section" aria-labelledby="fresh-title">
        <div className="section-head">
          <h2 id="fresh-title">How fresh it is</h2>
        </div>
        <ul>
          <li>The newest discussions are searchable within about a minute of adding a repository; the history follows in the background.</li>
          <li>New and changed discussions are picked up every hour.</li>
          <li>Deleted comments leave the index within a week.</li>
        </ul>
      </section>
      <section className="section" aria-labelledby="limits-title">
        <div className="section-head">
          <h2 id="limits-title">Limits</h2>
        </div>
        <ul>
          <li>The service runs on free tiers and holds 25 repositories at a time.</li>
          <li>Each stream stops at 5,000 items; older history is not included.</li>
          <li>A repository that GitHub stops serving stays searchable for 30 days, then its data is removed.</li>
        </ul>
        <p className="meta">
          The <Link to="/status">service status</Link> shows every allowance as it stands now.
        </p>
      </section>
    </>
  );
}
