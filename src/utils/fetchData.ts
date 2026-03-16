import axios, { AxiosError } from 'axios';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNetworkError = (error: unknown): boolean => {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const code = axiosError.code;
    return (
      code === 'ETIMEDOUT' ||
      code === 'ENETUNREACH' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      !axiosError.response
    );
  }
  return false;
};

const fetchData = async (url: string) => {
  const retries = 3;
  const timeout = 10000;
  const retryDelay = 1000;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        family: 4,
      });
      return response.data;
    } catch (error) {
      const isLastAttempt = attempt === retries;

      if (isNetworkError(error) && !isLastAttempt) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        console.warn(
          `Network error (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s...`
        );
        await sleep(delay);
        continue;
      }

      if (isLastAttempt && isNetworkError(error)) {
        console.error(
          `Network timeout after ${retries} attempts -`,
          axios.isAxiosError(error) ? error.code : 'Unknown error'
        );
      }
      throw error;
    }
  }
};

export default fetchData;
