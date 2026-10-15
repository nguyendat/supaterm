import { Spinner } from "~/components/ui/spinner";

import { ComposerBanner } from "./ComposerBanner";

export function ComposerActivityRow() {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <Spinner />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status="syncing"
          role="status"
        >
          Syncing messages...
        </span>
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
