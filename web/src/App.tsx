import { useEffect, useRef } from "react";
import { LiveRegionProvider } from "./components/LiveRegion.tsx";
import { ServiceStatusProvider } from "./components/ServiceStatusProvider.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { Icon } from "./components/Icon.tsx";
import { Link } from "./components/Link.tsx";
import { matchRoute, useLocation } from "./lib/router.ts";
import AboutPage from "./pages/About.tsx";
import HomePage from "./pages/Home.tsx";
import NotFoundPage from "./pages/NotFound.tsx";
import RepositoryPage from "./pages/Repository.tsx";
import StatusPage from "./pages/Status.tsx";
import "./styles/layout.css";
import "./styles/components.css";

function App() {
  const location = useLocation();
  const route = matchRoute(location.pathname);

  // Each navigation lands on the page heading; the first render leaves the focus where the browser put it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById("page-title")?.focus();
  }, [location.pathname]);

  // "{Page} | ContextTrace", so tabs and history read well.
  useEffect(() => {
    const title = route.page === "repository" ? `${route.owner}/${route.name}` : route.page === "status" ? "Service status" : route.page === "about" ? "How it works" : route.page === "notFound" ? "Not found" : null;
    document.title = title ? `${title} | ContextTrace` : "ContextTrace";
  }, [route]);

  let page;
  switch (route.page) {
    case "home":
      page = <HomePage />;
      break;
    case "repository":
      page = <RepositoryPage key={`${route.owner}/${route.name}`} owner={route.owner} name={route.name} />;
      break;
    case "status":
      page = <StatusPage />;
      break;
    case "about":
      page = <AboutPage />;
      break;
    default:
      page = <NotFoundPage />;
  }

  return (
    <LiveRegionProvider>
      <ServiceStatusProvider>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site">
          <Link to="/" className="brand">
            <Icon name="trace" />
            ContextTrace
          </Link>
          <nav aria-label="Site">
            <Link to="/about" className="quiet">
              About
            </Link>
            <StatusStrip />
          </nav>
        </header>
        <main id="main">{page}</main>
        <footer className="site">
          <p className="meta">
            Public discussions only; the code is never read.{" "}
            <Link to="/about" className="quiet">
              How it works
            </Link>{" "}
            ·{" "}
            <Link to="/status" className="quiet">
              Status
            </Link>
          </p>
        </footer>
      </ServiceStatusProvider>
    </LiveRegionProvider>
  );
}

export default App;
