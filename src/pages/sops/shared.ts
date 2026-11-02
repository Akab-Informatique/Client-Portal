import { api } from "@/lib/api";
import { blobToBase64, type Shot } from "@/lib/sop/image";

export type Mark = { kind: "pin" | "box"; x: number; y: number; w?: number; h?: number };
export type SopStep = {
  id: string;
  position: number;
  title: string;
  description: string;
  marks: Mark[];
  source: "manual" | "auto" | "paste" | "upload" | "text";
  hasImage: boolean;
  imageWidth: number | null;
  imageHeight: number | null;
  updatedAt: string;
};
export type SopCard = {
  id: string;
  title: string;
  description: string;
  status: "draft" | "published";
  tags: string[];
  author: string | null;
  mine: boolean;
  stepCount: number;
  coverStepId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SopDetail = Omit<SopCard, "stepCount" | "coverStepId"> & { canEdit: boolean; steps: SopStep[] };

export const imageUrl = (sopId: string, s: Pick<SopStep, "id" | "updatedAt">) => `/api/sops/${sopId}/steps/${s.id}/image?v=${encodeURIComponent(s.updatedAt)}`;
export const coverUrl = (c: SopCard) => (c.coverStepId ? `/api/sops/${c.id}/steps/${c.coverStepId}/image?v=${encodeURIComponent(c.updatedAt)}` : null);

/** What a step is called when its title was left empty */
export const stepName = (s: Pick<SopStep, "title">, index: number, word: string) => s.title.trim() || `${word} ${index + 1}`;

export const imageBody = async (shot: Shot) => ({ type: "image/jpeg" as const, data: await blobToBase64(shot.blob), width: shot.width, height: shot.height });

/** A step with its picture, added last (or after another) */
export async function addPictureStep(sopId: string, shot: Shot, source: SopStep["source"], after?: string | null) {
  return api.post<SopStep>(`/sops/${sopId}/steps`, { source, image: await imageBody(shot), ...(after ? { after } : {}) });
}

/** Download a text or blob as a file */
export function saveAs(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fileName = (title: string) => title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80) || "procedure";
