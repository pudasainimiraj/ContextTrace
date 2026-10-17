import { Link } from "../components/Link.tsx";

export default function NotFoundPage() {
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        There is no page here
      </h1>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}
