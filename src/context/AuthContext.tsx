import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiRequest, getStoredToken, setStoredToken } from '../api/client.ts';
import type { User, UserPreferences } from '../types.ts';
import { useTheme } from './ThemeContext.tsx';

interface AuthContextValue {
  user: User | null;
  preferences: UserPreferences | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (fullName: string, email: string, password: string, targetExams?: string) => Promise<User>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const { setDarkMode } = useTheme();

  const refreshUser = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setUser(null);
      setPreferences(null);
      setLoading(false);
      return;
    }
    try {
      const me = await apiRequest<User & { preferences?: UserPreferences }>('/auth/me');
      setUser(me);
      if (me.preferences) {
        setPreferences(me.preferences);
        if (typeof me.preferences.dark_mode === 'boolean') {
          setDarkMode(me.preferences.dark_mode);
        }
      }
    } catch {
      setStoredToken(null);
      setUser(null);
      setPreferences(null);
    } finally {
      setLoading(false);
    }
  }, [setDarkMode]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password: string): Promise<User> => {
    const res = await apiRequest<{ access_token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setStoredToken(res.access_token);
    setUser(res.user);
    await refreshUser();
    return res.user;
  };

  const register = async (
    fullName: string,
    email: string,
    password: string,
    targetExams = 'UPSC, SSC, IBPS'
  ): Promise<User> => {
    const res = await apiRequest<{ access_token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ full_name: fullName, email, password, target_exams: targetExams }),
    });
    setStoredToken(res.access_token);
    setUser(res.user);
    await refreshUser();
    return res.user;
  };

  const logout = () => {
    setStoredToken(null);
    setUser(null);
    setPreferences(null);
  };

  return (
    <AuthContext.Provider value={{ user, preferences, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
