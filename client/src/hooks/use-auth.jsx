import { createContext, useContext, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
// the splash logo is the site's entrance animation — hold it on screen for at
// least this long, even when Firebase resolves the session in milliseconds
const MIN_SPLASH_MS = 2100;
const AuthContext = createContext({
    user: null,
    loading: true,
    logout: async () => { },
});
export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const bootAt = useRef(Date.now());
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            // keep the entrance animation up for its full beat, then release
            const wait = Math.max(0, MIN_SPLASH_MS - (Date.now() - bootAt.current));
            window.setTimeout(() => setLoading(false), wait);
        });
        return () => unsubscribe();
    }, []);
    const logout = async () => {
        try {
            await signOut(auth);
        }
        catch (error) {
            console.error("Logout failed", error);
        }
    };
    return (<AuthContext.Provider value={{ user, loading, logout }}>
      {children}
    </AuthContext.Provider>);
}
export const useAuth = () => useContext(AuthContext);
