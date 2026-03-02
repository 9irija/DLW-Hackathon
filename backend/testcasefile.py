#meant to test the parsing of factchecker and builder


import numpy as np
import matplotlib.pyplot as plt
import pandas as pd
from time import process_time

# def mergeSort(arr, l ,mid, r):
#     if len(arr) <= 1:
#         return 0

#     mid = len(arr) // 2
#     left_c = mergeSort(arr[:mid])
#     right_c = mergeSort(arr[mid:])

#     merge_c = merge(arr[:mid], arr[mid:])
#     return left_c + right_c + merge_c

# def merge(left, right):
#     c = 0 
#     i = j = 0

#     while i < len(left) and j < len(right):
#         c += 1
#         if left[i] < right[j]:
#             i += 1
#         else:
#             j += 1

#     return c

#sorting algos

def merge(arr, l, mid, r):    #takes the two sorted arrays and merges them to produce a sorted array
    left = arr[l:mid+1]        #copies the left and right halves of the array
    right = arr[mid+1:r+1]      #the two arrays that are split are assumed to be sorted already
    
    i = j = 0 #i refer to the left array index, j refers to right array index
    k = l
    c = 0
    
    while i < len(left) and j < len(right):
        c += 1         # Count comparisons during merging
        if left[i] <= right[j]: #if right array is more than or equal to left, copy left array element to front
            arr[k] = left[i]
            i += 1
        else:
            arr[k] = right[j]
            j += 1
        k += 1
    
    # Copy remaining elements to array
    while i < len(left):
        arr[k] = left[i]
        i += 1
        k += 1
        
    while j < len(right):
        arr[k] = right[j]
        j += 1
        k += 1
    
    return c

def insertionSort(arr, l, r):
    c = 0

    for i in range(l + 1, r + 1):
        key = arr[i]
        j = i - 1
        
        while j >= l:
            c += 1  # count comparison
            if arr[j] > key:
                arr[j + 1] = arr[j]
                j -= 1
            else:
                break
        arr[j + 1] = key

    return c


def mergeSort(arr, l, r):
    if l >= r:
        return 0  
    
    mid = (l + r) // 2
    c1 = mergeSort(arr, l, mid)
    c2 = mergeSort(arr, mid + 1, r)
    c3 = merge(arr, l, mid, r)   
    
    return c1 + c2 + c3

def mergeInsertionSort(arr, l, r, S):
    if(r-l<=0):
        return 0
    
    #if less than or equal to S, use insertion sort on sub array
    if(r-l+1<=S):
        return insertionSort(arr, l, r)
    
    mid = (l+r)//2
    c1 = mergeInsertionSort(arr, l, mid, S)
    c2 = mergeInsertionSort(arr, mid+1, r, S)
    c3 = merge(arr, l, mid, r)

    return c1+c2+c3

##########################################################
#generating the arrays

ex = [3,4,5,6] #exponents
data = []

for n in ex:
    data.append(np.random.randint(1000000, size = 10**n).tolist())

data.append(np.random.randint(1000000, size = 5000000).tolist())

#data holds the lists of 1000, 10 000, 100 000, 1 000 000, 5 000 000
##########################################################

# COMPARISONS

#NOTE: if you want to make the program run faster
        #when running the hybrid vs merge sort comparisons functions
        #just comment the below code
##########################################################
#key comparisons for fixed S vs varied n
keyComp1 = []

for i in range(5):
    temp = list(data[i])
    comparisons = mergeInsertionSort(temp, 0, len(temp)-1, 5) #fixed S = 5
    keyComp1.append(comparisons)


#key comparisons for fixed n vs varied S
keyComp2 = []
#fixed n = 100000
for S in range(2,101):
    temp2 = list(data[2])
    comparisons = mergeInsertionSort(temp2, 0, 100000-1, S) #n = 100000
    keyComp2.append(comparisons)

# adds both x and y together 
def additionxy(x, y):
    return x-y


##########################################################


#graph plotting

#first pair of functions: actual result graph of comparisons vs n & comparisons vs S
#second pair: theoretical graph of comparisons vs n & comparisons vs S
#third pair: combined result and theoretical graph of comparisons vs n & comparisons vs S
##########################################################
# for comparisons/input size
#fixed s = 5 here
def graphCompVsN(): 
    xaxis = [1000,10000,100000,1000000,5000000]

    f,axes = plt.subplots(1,1,figsize=(16,10))
    plt.plot(xaxis, keyComp1, linewidth=3)
    plt.xlabel("Size of array")
    plt.ylabel("Key comparisons")
    plt.title('Key comparisons against n', fontsize=20)
    plt.xscale('log') 
    plt.show()

# for comparisons/threshold S
#fixed n = 100 000
def graphCompVsS():
    xaxis = []
    for s in range(2,101):
        xaxis.append(s)

    f,axes = plt.subplots(1,1,figsize=(16,10)) #f can be used to save the pic as png
    plt.plot(xaxis, keyComp2, linewidth=3)
    plt.xlabel("Threshold S")
    plt.ylabel("Key comparisons")
    plt.title('Key comparisons against threshold S', fontsize=20)
    # plt.xscale('log') 
    plt.show()

#for theoretical analysis of comparisons/input n
#fixed S = 5
def graphTheoryCompVsN():
    x = np.array(range(0,5000000+1))
    y = x*5 + x*(np.log2(x/5)) #nS + n*log2(n/S)
    plt.plot(x,y, linewidth=3)
    plt.xlabel("Size of array")
    plt.ylabel("Key comparisons")
    plt.title('Key comparisons against n', fontsize=20)
    plt.xscale('log') 
    plt.show()

#for theoretical analysis of comparisons/input s
#fixed n = 100 000
def graphTheoryCompVsS():
    x = np.array(range(2,101))
    y = x*1000000 + 1000000*(np.log2(1000000/x))
    plt.plot(x,y, linewidth=3)
    plt.xlabel("Threshold S")
    plt.ylabel("Key comparisons")
    plt.title('Key comparisons against threshold S', fontsize=20)
    # plt.xscale('log') 
    plt.show()

#comparison of theory and actual for comparisons/n
#fixed s = 5 here
def doublegraph_CompareVsN():
    #the theoretical graph
    x = np.array(range(0,5000000+1))
    y = x*5 + x*(np.log2(x/5)) #nS + n*log2(n/S)
    #actual results graph
    xaxis = [1000,10000,100000,1000000,5000000]

    f,axes = plt.subplots(1,1,figsize=(16,10))
    plt.plot(x,y, linewidth=3, label = "Theoretical results") 
    plt.plot(xaxis, keyComp1, linewidth=3,  label = "Actual results")
    plt.legend()
    plt.xlabel("Size of array")
    plt.ylabel("Key comparisons")
    plt.title('Key comparisons against n', fontsize=20)
    plt.xscale('log') 
    plt.show()

#comparison of theory and actual for comparisons/S
#fixed n = 100 000
def doublegraph_CompareVsS():
    #theoretical graph
    x = np.array(range(2,101))
    y = x*100000 + 100000*(np.log2(100000/x))
    #actual results graph
    xaxis = []
    for s in range(2,101):
        xaxis.append(s)

    plt.plot(x,y, linewidth=3, label = "Theoretical results")
    plt.plot(xaxis, keyComp2, linewidth=3, label = "Actual results")
    plt.legend()
    plt.xlabel("Threshold S")
    plt.ylabel("Key comparisons")
    plt.title('Key comparisons against threshold S', fontsize=20)
    # plt.xscale('log') 
    plt.show()

#graphs to find lowest S
def graph_lowestS(i): #only for index 0 to 4
    xaxis = []
    keyCompS = []
    for s in range(2,11): #narrow down the range
        xaxis.append(s)
        tempS = list(data[i])
        comparisons = mergeInsertionSort(tempS, 0, len(data[i])-1, s) 
        keyCompS.append(comparisons)

    plt.plot(xaxis, keyCompS, linewidth=3)
    plt.xlabel("Threshold S")
    plt.ylabel("Key comparisons")
    plt.title('Key comparisons against threshold S', fontsize=20)
    # plt.xscale('log') 
    plt.show()

##########################################################

#COMPARISONS OF HYBRID & MERGE
#process time and comparisons

#NOTE: below the S is set to 6 as indicated by the comments
#if u want to use a different s, u just replace the 6 in those lines with ur number of choice

#fixed S = 3? needs to be higher if u want to let insertion sort work its magic
#according to chatgpt anyways
#for now set it to 6
#fixed n = 5000000 aka data[4]
##########################################################

def timeCompare():
    timesHybrid = []
    list1 = list(data[4])
    list2 = list(data[4])
    timesMerge = []
    for i in range(5): #compare five times to find the average
        start2 = process_time()
        mergeSort(list2, 0, len(list2)-1)
        end2 = process_time()
        time_taken2 = end2 - start2
        timesMerge.append(time_taken2) 

    for i in range(5): #compare five times to find the average
        start1 = process_time()
        mergeInsertionSort(list1,0,len(list1)-1,6) #for now, set to 6
        end1 = process_time()
        time_taken1 = end1 - start1
        timesHybrid.append(time_taken1) 
    
    avgHybrid = sum(timesHybrid) / 5
    avgMerge = sum(timesMerge) / 5

    dataTimes = {'Sorting algorithm': ['Hybrid sort', 'Merge sort'],
        'Average time': [avgHybrid, avgMerge]}
    df = pd.DataFrame(dataTimes)
    ax = df.plot(x='Sorting algorithm', y='Average time', kind='bar')
    plt.title('Hybrid VS Merge Time Comparison')
    plt.ylabel('Average time taken (s)')

    for p in ax.patches:
        ax.annotate(str(p.get_height()), #labels the comparisons on the bar
                (p.get_x() + p.get_width() / 2., p.get_height() / 2.), #aligns the label
                ha='center', va='center', fontsize=10, color='white')

    plt.show()


def kcCompare(): #key comparisons compare

    list1 = list(data[4])
    list2 = list(data[4])
    kc_Merge = mergeSort(list2, 0, len(list2)-1)
    kc_Hybrid = mergeInsertionSort(list1,0,len(list1)-1,6) #for now set to 6
    

    dataKC = {'Sorting algorithm': ['Hybrid sort','Merge sort'],
            'Key comparisons': [kc_Hybrid, kc_Merge],}
    df2 = pd.DataFrame(dataKC)
    ax = df2.plot(x='Sorting algorithm', y='Key comparisons', kind='bar')
    plt.title('Hybrid VS Merge Comparison')
    plt.ylabel('Number of key comparisons')

    for p in ax.patches:
        ax.annotate(str(p.get_height()), #labels the comparisons on the bar
                (p.get_x() + p.get_width() / 2., p.get_height() / 2.), #aligns the label
                ha='center', va='center', fontsize=10, color='white')

    plt.show()


##########################################################

def main():
    timeCompare()


main()


