import { ethers } from 'ethers';

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const getMyBalance = async (
    address: string,
    rpcUrl: string,
    usdcContractAddress: string
): Promise<number> => {
    if (!rpcUrl || !usdcContractAddress) {
        throw new Error('RPC URL or USDC contract address not configured in settings');
    }

    const rpcProvider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const usdcContract = new ethers.Contract(usdcContractAddress, USDC_ABI, rpcProvider);
    const balance_usdc = await usdcContract.balanceOf(address);
    const balance_usdc_real = ethers.utils.formatUnits(balance_usdc, 6);
    return parseFloat(balance_usdc_real);
};

export default getMyBalance;
