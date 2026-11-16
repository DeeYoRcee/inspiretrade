import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useUserProfile } from "@/hooks/use-premium";
import { UsernameDialog } from "@/components/dashboard/UsernameDialog";
export function UsernamePrompt() {
    const { user } = useAuth();
    const { data: profile, isLoading } = useUserProfile();
    const [open, setOpen] = useState(false);
    useEffect(() => {
        // Kiriganida profil yo'q bo'lsa yoki username yo'q bo'lsa — majburiy username dialog
        if (!isLoading && user && profile !== undefined) {
            if (!profile?.username) {
                // Kichik kechikish bilan — sahifa to'liq yuklangandan keyin
                // (mobil qurilmalarda render/splash tugallanishi uchun 3s)
                const timer = setTimeout(() => setOpen(true), 3000);
                return () => clearTimeout(timer);
            }
        }
    }, [user, profile, isLoading]);
    if (!user || !open)
        return null;
    return (<UsernameDialog open={open} currentUsername={profile?.username} isPremium={profile?.isPremium} onClose={() => setOpen(false)}/>);
}
