import { useCallback, useEffect, useState } from 'react';

import {
  FILE_TREE_DEFAULT_SHOW_HIDDEN,
  FILE_TREE_SHOW_HIDDEN_STORAGE_KEY,
} from '../constants/constants';

type UseFileTreeHiddenResult = {
  showHidden: boolean;
  setShowHidden: (next: boolean) => void;
  toggleShowHidden: () => void;
};

// Toggle for showing dot-directories (`.git`, `.svn`, `.hg`) and other
// entries the server only returns when explicitly opted in. Mirrors the
// localStorage pattern of `useFileTreeViewMode`: read once on mount, write
// back on every change, fall back to the default if storage is unavailable.
export function useFileTreeHidden(): UseFileTreeHiddenResult {
  const [showHidden, setShowHiddenState] = useState<boolean>(FILE_TREE_DEFAULT_SHOW_HIDDEN);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(FILE_TREE_SHOW_HIDDEN_STORAGE_KEY);
      if (saved === 'true') setShowHiddenState(true);
      else if (saved === 'false') setShowHiddenState(false);
    } catch {
      // Default already applied.
    }
  }, []);

  const setShowHidden = useCallback((next: boolean) => {
    setShowHiddenState(next);
    try {
      localStorage.setItem(FILE_TREE_SHOW_HIDDEN_STORAGE_KEY, String(next));
    } catch {
      // Keep runtime state even when persistence fails.
    }
  }, []);

  const toggleShowHidden = useCallback(() => {
    setShowHidden(!showHidden);
  }, [showHidden, setShowHidden]);

  return { showHidden, setShowHidden, toggleShowHidden };
}