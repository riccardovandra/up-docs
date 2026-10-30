import { navigate } from "../router.ts";

/** "Docs", back to the home page; the doc header and Settings lead with it. */
export function HomeLink() {
  return (
    <a
      href="/"
      className="home-link"
      onClick={(event) => {
        event.preventDefault();
        navigate("/");
      }}
    >
      UP Docs
    </a>
  );
}
