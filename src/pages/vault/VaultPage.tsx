import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, KeyRound, Vault } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/session";

const VAULT_URL = "https://vault.akab.ca";

/** Whether this person already signed in to Vault in a tab on this browser (Microsoft 365 sign-in cannot happen inside a frame) */
function readSeen(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeSeen(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* private window: the first-sign-in card simply shows again next time */
  }
}

/** My IT tools > Vault: vault.akab.ca inside the portal. First time, the sign-in (Microsoft 365) is done in a new tab. */
export function VaultPage() {
  const { t } = useTranslation();
  const me = useMe();
  const key = `akab.vault.signedIn.${me.id}`;
  const [seen, setSeen] = useState(() => readSeen(key));
  const [opened, setOpened] = useState(false);

  const openTab = () => window.open(VAULT_URL, "_blank", "noopener,noreferrer");
  const finish = () => {
    writeSeen(key, true);
    setSeen(true);
  };
  const again = () => {
    writeSeen(key, false);
    setSeen(false);
    setOpened(false);
  };

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
        <Vault className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl font-semibold">{t("vault.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("vault.subtitle")}</p>
      </div>
      {seen && (
        <>
          <Button variant="outline" size="sm" onClick={again}>
            <KeyRound className="mr-1 size-4" />
            {t("vault.signAgain")}
          </Button>
          <Button variant="outline" size="sm" onClick={openTab}>
            <ExternalLink className="mr-1 size-4" />
            {t("vault.openTab")}
          </Button>
        </>
      )}
    </div>
  );

  if (!seen) {
    return (
      <div className="space-y-6">
        {header}
        <div className="glass mx-auto max-w-xl space-y-4 rounded-2xl p-6">
          <h2 className="font-display text-lg font-semibold">{t("vault.firstTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("vault.firstText")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                openTab();
                setOpened(true);
              }}
            >
              <ExternalLink className="mr-1 size-4" />
              {t("vault.firstOpen")}
            </Button>
            <Button variant={opened ? "default" : "outline"} onClick={finish}>
              {t("vault.firstDone")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("vault.firstHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      <iframe
        title={t("vault.frameTitle")}
        src={VAULT_URL}
        allow="clipboard-read; clipboard-write; publickey-credentials-get; publickey-credentials-create"
        className="w-full rounded-xl border-0"
        style={{ border: 0, width: "100%", height: "calc(100vh - 11rem)", minHeight: 480 }}
      />
    </div>
  );
}
