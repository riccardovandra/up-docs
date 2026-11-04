import { useEmbedProject } from "../embedContext.ts";
import { navigate } from "../router.ts";

/**
 * "UP Docs", back to the home page; the doc header and Settings lead with it.
 * Inside a locked embed it names that project, since home shows only it.
 */
export function HomeLink() {
  const project = useEmbedProject();
  return (
    <a
      href="/"
      className="home-link"
      onClick={(event) => {
        event.preventDefault();
        navigate("/");
      }}
    >
      {project?.locked ? project.name : "UP Docs"}
    </a>
  );
}
