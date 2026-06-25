export interface MediaConfig {
  images: boolean;
  videos: boolean; 
  audio: boolean;
  other: boolean;
}

export interface DownloadProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

export interface FetchOptions {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  beforeId?: string;
  afterId?: string;
  afterTimestamp?: number;
  beforeTimestamp?: number;
  onStatus?: (message: string) => void;
}
