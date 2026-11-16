import { z } from "zod";
export const api = {
    health: {
        get: {
            method: "GET",
            path: "/api/health",
            responses: {
                200: z.object({ status: z.string() }),
            },
        },
    },
};
export function buildUrl(path, params) {
    let url = path;
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (url.includes(`:${key}`)) {
                url = url.replace(`:${key}`, String(value));
            }
        });
    }
    return url;
}
